use std::{
    collections::{HashMap, VecDeque},
    env, fs,
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde_json::{Map, Value, json};

const MAX_LINE_BYTES: usize = 8 * 1024 * 1024;
const MAX_PROMPT_BYTES: usize = 128 * 1024;
const MAX_DELTA_BYTES: usize = 64 * 1024;
const MAX_TURN_OUTPUT_BYTES: usize = 8 * 1024 * 1024;
const MAX_ID_BYTES: usize = 128;
const MAX_ERROR_CHARS: usize = 2_048;
const MAX_SESSIONS: usize = 256;
const MAX_QUEUED_PROMPTS: usize = 8;
const MAX_PERMISSION_OPTIONS: usize = 16;
const MAX_PERMISSION_OPTION_ID_BYTES: usize = 128;
const MAX_MODEL_BYTES: usize = 128;
const MAX_ROUTED_MODEL_BYTES: usize = 256;
const MAX_TITLE_BYTES: usize = 512;
const MAX_KIND_BYTES: usize = 128;
const MAX_PATH_BYTES: usize = 4 * 1024;
const MAX_RAW_INPUT_BYTES: usize = 4 * 1024;
const MAX_TOOL_OUTPUT_BYTES: usize = 64 * 1024;
const MAX_METADATA_TEXT_BYTES: usize = 64 * 1024;
const MAX_PLAN_ITEMS: usize = 256;
const MAX_TASK_ITEMS: usize = 512;
const MAX_TIMELINE_ITEMS: usize = 512;
const MAX_AVAILABLE_COMMANDS: usize = 256;
const MAX_TOOL_CALLS: usize = 1_024;
const MAX_CHILD_ID_BYTES: usize = 128;
const RPC_IDLE_TIMEOUT: Duration = Duration::from_secs(30 * 60);
const WRITER_QUEUE_CAPACITY: usize = 64;
const INBOUND_QUEUE_CAPACITY: usize = 256;
const ACP_MODE_ID: &str = "ask";

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub(crate) struct AcpUsage {
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) cache_input_tokens: Option<u64>,
    pub(crate) cache_read_tokens: Option<u64>,
    pub(crate) cache_write_tokens: Option<u64>,
    pub(crate) cost_micro_usd: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpContext {
    pub(crate) system_prompt_bytes: u64,
    pub(crate) system_tools_bytes: u64,
    pub(crate) mcp_tools_bytes: u64,
    pub(crate) skills_bytes: u64,
    pub(crate) memory_bytes: u64,
}

impl Default for AcpContext {
    fn default() -> Self {
        Self {
            system_prompt_bytes: 0,
            system_tools_bytes: 0,
            mcp_tools_bytes: 0,
            skills_bytes: 0,
            memory_bytes: 0,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpDiffLine {
    pub(crate) kind: String,
    pub(crate) line: u64,
    pub(crate) text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpEditDiff {
    pub(crate) path: String,
    pub(crate) added: u64,
    pub(crate) removed: u64,
    pub(crate) hunks: Vec<AcpDiffLine>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpToolCall {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) kind: String,
    pub(crate) tool_name: Option<String>,
    pub(crate) status: String,
    pub(crate) input: String,
    pub(crate) output: String,
    pub(crate) path: Option<String>,
    pub(crate) edit: Option<AcpEditDiff>,
    pub(crate) command_result: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpAgentUpdate {
    pub(crate) id: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) title: String,
    pub(crate) brief: String,
    pub(crate) color: Option<String>,
    pub(crate) status: String,
    pub(crate) model: Option<String>,
    pub(crate) effort: Option<String>,
    pub(crate) activity: Option<String>,
    pub(crate) prompt: Option<String>,
    pub(crate) tool: bool,
    pub(crate) started_at: u64,
    pub(crate) ended_at: Option<u64>,
    pub(crate) steps: u64,
    pub(crate) tool_calls: u64,
    pub(crate) input_tokens: u64,
    pub(crate) output_tokens: u64,
    pub(crate) generation_ms: u64,
    pub(crate) error: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpPlanStep {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) needs: Vec<String>,
    pub(crate) brief: String,
    pub(crate) result: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpPlan {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) goal: String,
    pub(crate) updated_at: String,
    pub(crate) steps: Vec<AcpPlanStep>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpTask {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) status: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) depth: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpTaskList {
    pub(crate) id: String,
    pub(crate) title: String,
    pub(crate) goal: String,
    pub(crate) updated_at: String,
    pub(crate) tasks: Vec<AcpTask>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpTimelineSpan {
    pub(crate) id: String,
    pub(crate) parent_id: Option<String>,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) started_at: u64,
    pub(crate) ended_at: Option<u64>,
    pub(crate) status: String,
    pub(crate) input: Option<String>,
    pub(crate) output: Option<String>,
    pub(crate) tokens: Option<u64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpCompletionItem {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
    pub(crate) detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpCompletionMenu {
    pub(crate) sigil: String,
    pub(crate) query: String,
    pub(crate) items: Vec<AcpCompletionItem>,
    pub(crate) active: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpAvailableCommand {
    pub(crate) id: String,
    pub(crate) name: String,
    pub(crate) detail: String,
    pub(crate) raw: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpContextExperiment {
    pub(crate) pruned_results: u64,
    pub(crate) reinjected: bool,
    pub(crate) saved_tokens: u64,
    pub(crate) added_tokens: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpRecovery {
    pub(crate) state: String,
    pub(crate) kind: Option<String>,
    pub(crate) cause: Option<String>,
    pub(crate) action: Option<String>,
    pub(crate) required_action: Option<String>,
    pub(crate) attempt: Option<u64>,
    pub(crate) attempt_limit: Option<u64>,
    pub(crate) delay_seconds: Option<u64>,
    pub(crate) durable: bool,
    pub(crate) message: String,
}

#[derive(Debug)]
pub(crate) enum AcpEvent {
    Ready,
    TextDelta {
        thread_id: String,
        text: String,
    },
    ThoughtDelta {
        thread_id: String,
        text: String,
    },
    UserMessageDelta {
        thread_id: String,
        text: String,
    },
    ToolCall {
        thread_id: String,
        call: AcpToolCall,
    },
    Diff {
        thread_id: String,
        tool_call_id: String,
        edit: AcpEditDiff,
    },
    Subagent {
        thread_id: String,
        update: AcpAgentUpdate,
    },
    Plan {
        thread_id: String,
        plan: AcpPlan,
    },
    Tasks {
        thread_id: String,
        tasks: AcpTaskList,
    },
    Timeline {
        thread_id: String,
        span: AcpTimelineSpan,
    },
    Usage {
        thread_id: String,
        usage: AcpUsage,
    },
    Context {
        thread_id: String,
        context: AcpContext,
    },
    ContextExperiment {
        thread_id: String,
        experiment: AcpContextExperiment,
    },
    Completion {
        thread_id: String,
        menu: Option<AcpCompletionMenu>,
    },
    AvailableCommands {
        thread_id: String,
        commands: Vec<AcpAvailableCommand>,
    },
    Compacted {
        thread_id: String,
        removed_turns: u64,
        summary_chars: u64,
        model_written: bool,
    },
    RoutedModel {
        thread_id: String,
        model: String,
        fell_back: bool,
    },
    Recovery {
        thread_id: String,
        recovery: AcpRecovery,
    },
    Completed {
        thread_id: String,
        stop_reason: String,
        completed_at: u64,
        usage: AcpUsage,
    },
    PromptFinished {
        thread_id: String,
        stop_reason: String,
        usage: AcpUsage,
    },
    PermissionAsked {
        thread_id: Option<String>,
        session_id: Option<String>,
        permission_mode: Option<String>,
        request_id: String,
        title: String,
        tool: String,
        detail: String,
        parent_thread_id: Option<String>,
        options: Vec<AcpPermissionOption>,
    },
    PermissionResolved {
        thread_id: Option<String>,
        request_id: String,
        allowed: bool,
    },
    Error {
        thread_id: Option<String>,
        message: String,
    },
    ChildExited,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct AcpPermissionOption {
    pub(crate) option_id: String,
    pub(crate) name: String,
    pub(crate) kind: String,
}

#[derive(Clone)]
pub(crate) struct AcpClient {
    commands: async_channel::Sender<AcpCommand>,
    events: async_channel::Receiver<AcpEvent>,
}

enum AcpCommand {
    Prompt {
        thread_id: String,
        text: String,
        permission_mode: String,
        model: Option<String>,
    },
    Cancel {
        thread_id: String,
    },
    AnswerPermission {
        session_id: Option<String>,
        request_id: String,
        option_id: Option<String>,
    },
}

impl AcpClient {
    pub(crate) fn new() -> Self {
        let (commands, command_receiver) = async_channel::bounded(32);
        let (events, event_receiver) = async_channel::bounded(256);
        let binary = cli_binary();
        let worker_events = events.clone();
        let spawn = thread::Builder::new()
            .name("emma-acp-client".to_string())
            .spawn(move || acp_worker(binary, command_receiver, worker_events));
        if let Err(error) = spawn {
            let _ = events.try_send(AcpEvent::Error {
                thread_id: None,
                message: format!("could not start the native agent worker: {error}"),
            });
        }
        Self {
            commands,
            events: event_receiver,
        }
    }

    pub(crate) fn events(&self) -> async_channel::Receiver<AcpEvent> {
        self.events.clone()
    }

    pub(crate) fn prompt_with_config(
        &self,
        thread_id: String,
        text: String,
        permission_mode: String,
        model: Option<String>,
    ) -> Result<(), String> {
        validate_id(&thread_id, "thread ID")?;
        if text.trim().is_empty() {
            return Err("prompt is empty".to_string());
        }
        if text.len() > MAX_PROMPT_BYTES {
            return Err("prompt is too large".to_string());
        }
        validate_mode_id(&permission_mode)?;
        if let Some(model) = model.as_deref() {
            validate_model(model)?;
        }
        self.commands
            .try_send(AcpCommand::Prompt {
                thread_id,
                text,
                permission_mode,
                model,
            })
            .map_err(|error| format!("native agent worker unavailable: {error}"))
    }

    pub(crate) fn cancel(&self, thread_id: String) -> Result<(), String> {
        validate_id(&thread_id, "thread ID")?;
        self.commands
            .try_send(AcpCommand::Cancel { thread_id })
            .map_err(|error| format!("native agent worker unavailable: {error}"))
    }

    pub(crate) fn answer_permission(
        &self,
        session_id: Option<String>,
        request_id: String,
        option_id: Option<String>,
    ) -> Result<(), String> {
        validate_id(&request_id, "permission request ID")?;
        if let Some(session_id) = session_id.as_deref() {
            validate_id(session_id, "session ID")?;
        }
        if let Some(option_id) = option_id.as_deref()
            && (option_id.is_empty()
                || option_id.len() > MAX_PERMISSION_OPTION_ID_BYTES
                || !option_id.is_ascii())
        {
            return Err("permission option ID is invalid".to_string());
        }
        self.commands
            .try_send(AcpCommand::AnswerPermission {
                session_id,
                request_id,
                option_id,
            })
            .map_err(|error| format!("native agent worker unavailable: {error}"))
    }
}

fn cli_binary() -> PathBuf {
    if let Ok(path) = env::var("EMMA_CLI_BIN") {
        return PathBuf::from(path);
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/emma-cli")
}

fn acp_worker(
    binary: PathBuf,
    commands: async_channel::Receiver<AcpCommand>,
    events: async_channel::Sender<AcpEvent>,
) {
    let mut manager = Manager::new(binary, commands, events);
    manager.run();
}

struct Manager {
    binary: PathBuf,
    cwd: PathBuf,
    commands: async_channel::Receiver<AcpCommand>,
    events: async_channel::Sender<AcpEvent>,
    next_id: u64,
    pending: HashMap<u64, PendingRpc>,
    sessions: HashMap<String, String>,
    threads_by_session: HashMap<String, String>,
    queued: VecDeque<Prompt>,
    active: Option<ActivePrompt>,
    process: Option<ProcessState>,
    session_index: PathBuf,
    pending_permissions: HashMap<PermissionKey, PendingPermission>,
    tool_calls: HashMap<(String, String), AcpToolCall>,
    stderr_tail: String,
}

#[derive(Clone)]
struct Prompt {
    thread_id: String,
    text: String,
    permission_mode: String,
    model: Option<String>,
}

struct ActivePrompt {
    thread_id: String,
    permission_mode: String,
    bytes: usize,
}

enum RpcKind {
    Initialize,
    New(Prompt),
    Resume(Prompt),
    SetMode(Prompt),
    SetModel(Prompt),
    Prompt(String),
}

struct PendingRpc {
    kind: RpcKind,
    last_activity: Instant,
}

struct ProcessState {
    child: Child,
    writer: async_channel::Sender<Outbound>,
    inbound: async_channel::Receiver<Inbound>,
    initialized: bool,
}

enum Outbound {
    Message(Value),
    Close,
}

enum Inbound {
    Message(Value),
    Stderr(String),
    Eof(String),
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
struct PermissionKey {
    session_id: String,
    request_id: WireId,
}

struct PendingPermission {
    request_id: WireId,
    parent_thread_id: Option<String>,
    thread_id: Option<String>,
    options: Vec<AcpPermissionOption>,
}

#[derive(Clone, Debug, Hash, PartialEq, Eq)]
enum WireId {
    Number(u64),
    String(String),
}

impl WireId {
    fn value(&self) -> Value {
        match self {
            Self::Number(value) => Value::from(*value),
            Self::String(value) => Value::String(value.clone()),
        }
    }

    fn label(&self) -> String {
        match self {
            Self::Number(value) => value.to_string(),
            Self::String(value) => value.clone(),
        }
    }
}

impl Manager {
    fn new(
        binary: PathBuf,
        commands: async_channel::Receiver<AcpCommand>,
        events: async_channel::Sender<AcpEvent>,
    ) -> Self {
        let session_index = session_index_path();
        let sessions = load_session_index(&session_index);
        let threads_by_session = sessions
            .iter()
            .map(|(thread_id, session_id)| (session_id.clone(), thread_id.clone()))
            .collect();
        Self {
            binary,
            cwd: app_cwd(),
            commands,
            events,
            next_id: 1,
            pending: HashMap::new(),
            sessions,
            threads_by_session,
            queued: VecDeque::new(),
            active: None,
            process: None,
            session_index,
            pending_permissions: HashMap::new(),
            tool_calls: HashMap::new(),
            stderr_tail: String::new(),
        }
    }

    fn run(&mut self) {
        loop {
            let mut did_work = false;
            match self.commands.try_recv() {
                Ok(command) => {
                    did_work = true;
                    if self.handle_command(command) {
                        break;
                    }
                }
                Err(async_channel::TryRecvError::Closed) => break,
                Err(async_channel::TryRecvError::Empty) => {}
            }
            if let Some(inbound) = self.process.as_ref().map(|process| process.inbound.clone()) {
                while let Ok(message) = inbound.try_recv() {
                    did_work = true;
                    self.handle_inbound(message);
                }
            }
            self.check_process();
            self.check_pending_timeouts();
            if !did_work {
                thread::sleep(Duration::from_millis(5));
            }
        }
        self.stop_process();
    }

    fn handle_command(&mut self, command: AcpCommand) -> bool {
        match command {
            AcpCommand::Prompt {
                thread_id,
                text,
                permission_mode,
                model,
            } => {
                if self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.thread_id == thread_id)
                    || self
                        .queued
                        .iter()
                        .any(|prompt| prompt.thread_id == thread_id)
                {
                    self.error(Some(thread_id), "a prompt is already running".to_string());
                    return false;
                }
                if self.queued.len() >= MAX_QUEUED_PROMPTS {
                    self.error(Some(thread_id), "too many prompts are queued".to_string());
                    return false;
                }
                self.queued.push_back(Prompt {
                    thread_id,
                    text,
                    permission_mode,
                    model,
                });
                self.ensure_process();
                self.start_next();
            }
            AcpCommand::Cancel { thread_id } => {
                if let Some(position) = self
                    .queued
                    .iter()
                    .position(|prompt| prompt.thread_id == thread_id)
                {
                    self.queued.remove(position);
                    self.finish_cancelled(thread_id);
                } else if self
                    .active
                    .as_ref()
                    .is_some_and(|active| active.thread_id == thread_id)
                    && let Some(session_id) = self.sessions.get(&thread_id).cloned()
                {
                    self.cancel_permissions_for_thread(&thread_id);
                    let _ =
                        self.send_notification("session/cancel", json!({"sessionId": session_id}));
                }
            }
            AcpCommand::AnswerPermission {
                session_id,
                request_id,
                option_id,
            } => self.answer_permission(session_id, request_id, option_id),
        }
        false
    }

    fn ensure_process(&mut self) {
        if self.process.is_some() {
            return;
        }
        let mut command = Command::new(&self.binary);
        command
            .arg("acp")
            .current_dir(&self.cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Ok(home) = env::var("EMMA_HOME") {
            command.env("HOME", home);
        }
        let child = match command.spawn() {
            Ok(child) => child,
            Err(error) => {
                self.error(
                    None,
                    format!(
                        "could not start emma-cli at {}: {error}",
                        self.binary.display()
                    ),
                );
                return;
            }
        };
        let mut child = child;
        let Some(stdin) = child.stdin.take() else {
            self.error(None, "emma-cli did not provide stdin".to_string());
            let _ = child.kill();
            return;
        };
        let Some(stdout) = child.stdout.take() else {
            self.error(None, "emma-cli did not provide stdout".to_string());
            let _ = child.kill();
            return;
        };
        let Some(stderr) = child.stderr.take() else {
            self.error(None, "emma-cli did not provide stderr".to_string());
            let _ = child.kill();
            return;
        };
        let (writer, writer_receiver) = async_channel::bounded(WRITER_QUEUE_CAPACITY);
        let (inbound_sender, inbound) = async_channel::bounded(INBOUND_QUEUE_CAPACITY);
        let writer_spawn = thread::Builder::new()
            .name("emma-acp-writer".to_string())
            .spawn(move || write_loop(stdin, writer_receiver));
        if writer_spawn.is_err() {
            self.error(None, "could not start emma-cli writer".to_string());
            let _ = child.kill();
            return;
        }
        let reader_sender = inbound_sender.clone();
        let reader_spawn = thread::Builder::new()
            .name("emma-acp-reader".to_string())
            .spawn(move || read_loop(stdout, reader_sender));
        if reader_spawn.is_err() {
            self.error(None, "could not start emma-cli reader".to_string());
            let _ = child.kill();
            return;
        }
        let stderr_spawn = thread::Builder::new()
            .name("emma-acp-stderr".to_string())
            .spawn(move || stderr_loop(stderr, inbound_sender));
        if stderr_spawn.is_err() {
            self.error(None, "could not start emma-cli stderr reader".to_string());
            let _ = child.kill();
            return;
        }
        self.process = Some(ProcessState {
            child,
            writer,
            inbound,
            initialized: false,
        });
        let params = json!({
            "protocolVersion": 1,
            "clientCapabilities": {"fs": {"readTextFile": false, "writeTextFile": false}}
        });
        if self
            .send_request("initialize", params, RpcKind::Initialize)
            .is_err()
        {
            self.process_failed("could not initialize emma-cli".to_string());
        }
    }

    fn start_next(&mut self) {
        let Some(process) = self.process.as_ref() else {
            return;
        };
        if !process.initialized || self.active.is_some() {
            return;
        }
        let Some(prompt) = self.queued.pop_front() else {
            return;
        };
        let (method, params, kind) = match self.sessions.get(&prompt.thread_id) {
            Some(session_id) => (
                "session/resume",
                json!({"sessionId": session_id}),
                RpcKind::Resume(prompt),
            ),
            None => (
                "session/new",
                json!({"cwd": self.cwd.to_string_lossy()}),
                RpcKind::New(prompt),
            ),
        };
        if let Err(error) = self.send_request(method, params, kind) {
            self.error(None, error);
        }
    }

    fn send_request(&mut self, method: &str, params: Value, kind: RpcKind) -> Result<u64, String> {
        let writer = self
            .process
            .as_ref()
            .ok_or_else(|| "emma-cli is not running".to_string())?
            .writer
            .clone();
        let id = self.next_id;
        self.next_id = self.next_id.saturating_add(1).max(1);
        writer
            .try_send(Outbound::Message(request_value(id, method, params)))
            .map_err(|error| format!("could not write emma-cli request: {error}"))?;
        self.pending.insert(
            id,
            PendingRpc {
                kind,
                last_activity: Instant::now(),
            },
        );
        Ok(id)
    }

    fn send_notification(&self, method: &str, params: Value) -> Result<(), String> {
        let writer = self
            .process
            .as_ref()
            .ok_or_else(|| "emma-cli is not running".to_string())?
            .writer
            .clone();
        writer
            .try_send(Outbound::Message(notification_value(method, params)))
            .map_err(|error| format!("could not write emma-cli notification: {error}"))
    }

    fn send_response(&self, request_id: WireId, result: Value) -> Result<(), String> {
        let writer = self
            .process
            .as_ref()
            .ok_or_else(|| "emma-cli is not running".to_string())?
            .writer
            .clone();
        writer
            .try_send(Outbound::Message(json!({
                "jsonrpc": "2.0",
                "id": request_id.value(),
                "result": result
            })))
            .map_err(|error| format!("could not write emma-cli response: {error}"))
    }

    fn handle_inbound(&mut self, inbound: Inbound) {
        match inbound {
            Inbound::Message(value) => {
                self.touch_pending();
                self.handle_message(value);
            }
            Inbound::Stderr(message) => {
                if !message.is_empty() {
                    self.stderr_tail = message;
                }
            }
            Inbound::Eof(message) => self.process_failed(message),
        }
    }

    fn handle_message(&mut self, value: Value) {
        let Some(object) = value.as_object() else {
            self.protocol_error("emma-cli message must be an object".to_string());
            return;
        };
        if let Some(method) = object.get("method").and_then(Value::as_str) {
            self.handle_method(object, method);
            return;
        }
        let Some(id) = object.get("id").and_then(Value::as_u64) else {
            return;
        };
        let Some(kind) = self.pending.remove(&id).map(|pending| pending.kind) else {
            return;
        };
        if let Some(error) = object.get("error") {
            self.handle_rpc_error(kind, rpc_error(error));
            return;
        }
        self.handle_rpc_result(kind, object.get("result").cloned().unwrap_or(Value::Null));
    }

    fn handle_method(&mut self, object: &Map<String, Value>, method: &str) {
        match method {
            "session/update" => self.handle_update(object.get("params")),
            "session/request_permission" => {
                let Some(id) = object.get("id").and_then(parse_wire_id_value) else {
                    self.protocol_error("permission request has no valid id".to_string());
                    return;
                };
                self.handle_permission(id, object.get("params"));
            }
            "_emma/callTool" => {
                if let Some(id) = object.get("id").and_then(parse_wire_id_value) {
                    let _ = self.send_error_response(id, -32601, "native tool calls are disabled");
                }
            }
            _ => {
                if let Some(id) = object.get("id").and_then(parse_wire_id_value) {
                    let _ = self.send_error_response(
                        id,
                        -32601,
                        &format!("unsupported method {method}"),
                    );
                }
            }
        }
    }

    fn handle_update(&mut self, params: Option<&Value>) {
        let Some(params) = params.and_then(Value::as_object) else {
            self.protocol_error("session update params must be an object".to_string());
            return;
        };
        let Some(session_id) = params.get("sessionId").and_then(Value::as_str) else {
            self.protocol_error("session update has no session ID".to_string());
            return;
        };
        if validate_id(session_id, "session ID").is_err() {
            self.protocol_error("session update has an invalid session ID".to_string());
            return;
        }
        let Some(parent_thread_id) = self.threads_by_session.get(session_id).cloned() else {
            return;
        };
        let Some(update) = params.get("update").and_then(Value::as_object) else {
            self.error(
                Some(parent_thread_id),
                "session update has no update object".to_string(),
            );
            return;
        };
        let Some(kind) = update.get("sessionUpdate").and_then(Value::as_str) else {
            self.error(
                Some(parent_thread_id),
                "session update has no update kind".to_string(),
            );
            return;
        };
        let child = match parse_child_tag(update) {
            Ok(child) => child,
            Err(error) => {
                self.update_error(&parent_thread_id, kind, error);
                return;
            }
        };
        if let Some(child) = child.as_ref() {
            self.emit(AcpEvent::Subagent {
                thread_id: parent_thread_id.clone(),
                update: child.agent_update(&parent_thread_id),
            });
        }
        let thread_id = child
            .as_ref()
            .map(|child| child.id.clone())
            .unwrap_or_else(|| parent_thread_id.clone());
        let is_child = child.is_some();
        let result = match kind {
            "agent_message_chunk" => (|| -> Result<(), String> {
                let text = parse_text_chunk(update)?;
                self.emit_delta(
                    session_id,
                    &parent_thread_id,
                    &thread_id,
                    text,
                    false,
                    is_child,
                );
                Ok(())
            })(),
            "agent_thought_chunk" => (|| -> Result<(), String> {
                let text = parse_text_chunk(update)?;
                self.emit_delta(
                    session_id,
                    &parent_thread_id,
                    &thread_id,
                    text,
                    true,
                    is_child,
                );
                Ok(())
            })(),
            "user_message_chunk" => (|| -> Result<(), String> {
                let text = parse_text_chunk(update)?;
                if text.len() > MAX_DELTA_BYTES {
                    Err("user message update is too large".to_string())
                } else {
                    self.emit(AcpEvent::UserMessageDelta { thread_id, text });
                    Ok(())
                }
            })(),
            "tool_call" | "tool_call_update" => {
                self.handle_tool_update(&thread_id, update, kind == "tool_call")
            }
            "diff" | "diff_update" => (|| -> Result<(), String> {
                let tool_call_id = required_id(update, "toolCallId", "tool call ID")?;
                let edit = parse_edit_diff(update.get("edit").or_else(|| update.get("diff")))?
                    .ok_or_else(|| "diff update has no edit".to_string())?;
                self.emit(AcpEvent::Diff {
                    thread_id,
                    tool_call_id,
                    edit,
                });
                Ok(())
            })(),
            "plan" => (|| -> Result<(), String> {
                let plan = parse_plan(update)?;
                self.emit(AcpEvent::Plan { thread_id, plan });
                Ok(())
            })(),
            "task_list" | "task_list_update" | "tasks" => (|| -> Result<(), String> {
                let tasks = parse_task_list(update)?;
                self.emit(AcpEvent::Tasks { thread_id, tasks });
                Ok(())
            })(),
            "timeline" | "timeline_update" | "activity" | "activity_update" => {
                (|| -> Result<(), String> {
                    let span = parse_timeline_span(update)?;
                    self.emit(AcpEvent::Timeline { thread_id, span });
                    Ok(())
                })()
            }
            "completion" | "completion_update" => (|| -> Result<(), String> {
                let menu = parse_completion_menu(update)?;
                self.emit(AcpEvent::Completion { thread_id, menu });
                Ok(())
            })(),
            "available_commands_update" => (|| -> Result<(), String> {
                let commands = parse_available_commands(update)?;
                self.emit(AcpEvent::AvailableCommands {
                    thread_id,
                    commands,
                });
                Ok(())
            })(),
            "subagent" | "subagent_update" => (|| -> Result<(), String> {
                let update = parse_agent_update(update, Some(&parent_thread_id))?;
                self.emit(AcpEvent::Subagent {
                    thread_id: parent_thread_id.clone(),
                    update,
                });
                Ok(())
            })(),
            "_emma_compacted" => (|| -> Result<(), String> {
                let removed_turns = required_u64(update, "removedTurns")?;
                let summary_chars = required_u64(update, "summaryChars")?;
                let model_written = required_bool(update, "modelWritten")?;
                if removed_turns == 0 {
                    return Ok(());
                }
                self.emit(AcpEvent::Compacted {
                    thread_id,
                    removed_turns,
                    summary_chars,
                    model_written,
                });
                Ok(())
            })(),
            "session_info_update" => self.handle_session_info(&thread_id, update),
            _ => Ok(()),
        };
        if let Err(error) = result {
            self.update_error(&parent_thread_id, kind, error);
        }
    }

    fn emit_delta(
        &mut self,
        session_id: &str,
        parent_thread_id: &str,
        thread_id: &str,
        text: String,
        thought: bool,
        is_child: bool,
    ) {
        if text.len() > MAX_DELTA_BYTES {
            self.error(
                Some(parent_thread_id.to_string()),
                "agent update is too large".to_string(),
            );
            let _ = self.send_notification("session/cancel", json!({"sessionId": session_id}));
            self.active = None;
            return;
        }
        if !is_child {
            let Some(active) = self.active.as_mut() else {
                return;
            };
            if active.thread_id != parent_thread_id {
                return;
            }
            active.bytes = active.bytes.saturating_add(text.len());
            if active.bytes > MAX_TURN_OUTPUT_BYTES {
                self.error(
                    Some(parent_thread_id.to_string()),
                    "agent response is too large".to_string(),
                );
                let _ = self.send_notification("session/cancel", json!({"sessionId": session_id}));
                self.active = None;
                return;
            }
        }
        if thought {
            self.emit(AcpEvent::ThoughtDelta {
                thread_id: thread_id.to_string(),
                text,
            });
        } else {
            self.emit(AcpEvent::TextDelta {
                thread_id: thread_id.to_string(),
                text,
            });
        }
    }

    fn handle_tool_update(
        &mut self,
        thread_id: &str,
        update: &Map<String, Value>,
        initial: bool,
    ) -> Result<(), String> {
        let id = required_id(update, "toolCallId", "tool call ID")?;
        let key = (thread_id.to_string(), id.clone());
        let previous = self.tool_calls.get(&key);
        let call = parse_tool_call(update, initial, previous)?;
        if previous.is_none() && self.tool_calls.len() >= MAX_TOOL_CALLS {
            if let Some(key) = self.tool_calls.keys().next().cloned() {
                self.tool_calls.remove(&key);
            }
        }
        let edit = call.edit.clone();
        self.tool_calls.insert(key, call.clone());
        self.emit(AcpEvent::ToolCall {
            thread_id: thread_id.to_string(),
            call,
        });
        if let Some(edit) = edit {
            self.emit(AcpEvent::Diff {
                thread_id: thread_id.to_string(),
                tool_call_id: id,
                edit,
            });
        }
        Ok(())
    }

    fn handle_session_info(
        &mut self,
        thread_id: &str,
        update: &Map<String, Value>,
    ) -> Result<(), String> {
        let fx = parse_fx(update)?;
        let Some(fx) = fx else {
            return Ok(());
        };
        if let Some(value) = fx.get("turnUsage") {
            self.emit(AcpEvent::Usage {
                thread_id: thread_id.to_string(),
                usage: parse_usage_strict(value)?,
            });
        }
        if let Some(value) = fx.get("contextExperiment") {
            let experiment = parse_context_experiment(value)?;
            if experiment.pruned_results > 0 || experiment.reinjected {
                self.emit(AcpEvent::ContextExperiment {
                    thread_id: thread_id.to_string(),
                    experiment,
                });
            }
        }
        if let Some(value) = fx.get("contextBreakdown") {
            self.emit(AcpEvent::Context {
                thread_id: thread_id.to_string(),
                context: parse_context(value)?,
            });
        }
        if let Some(value) = fx.get("routedModel") {
            let model = parse_routed_model(value)?;
            self.emit(AcpEvent::RoutedModel {
                thread_id: thread_id.to_string(),
                model: model.0,
                fell_back: model.1,
            });
        }
        if let Some(value) = fx.get("modelResponseRecovery")
            && !value.is_null()
        {
            let recovery = parse_recovery(value)?;
            let line = recovery_line(&recovery);
            self.emit(AcpEvent::Recovery {
                thread_id: thread_id.to_string(),
                recovery,
            });
            self.emit(AcpEvent::ThoughtDelta {
                thread_id: thread_id.to_string(),
                text: format!("{line}\n"),
            });
        }
        Ok(())
    }

    fn update_error(&self, thread_id: &str, kind: &str, error: String) {
        self.error(
            Some(thread_id.to_string()),
            format!("invalid {kind} update: {error}"),
        );
    }

    fn handle_permission(&mut self, request_id: WireId, params: Option<&Value>) {
        let Some(object) = params.and_then(Value::as_object) else {
            let _ = self.send_response(request_id, cancelled_permission_result());
            return;
        };
        let Some(session_id) = object.get("sessionId").and_then(Value::as_str) else {
            let _ = self.send_response(request_id, cancelled_permission_result());
            return;
        };
        if validate_id(session_id, "session ID").is_err() {
            let _ = self.send_response(request_id, cancelled_permission_result());
            return;
        }
        let Some(parent_thread_id) = self.threads_by_session.get(session_id).cloned() else {
            let _ = self.send_response(request_id, cancelled_permission_result());
            return;
        };
        let child = match parse_child_tag(object) {
            Ok(child) => child,
            Err(error) => {
                self.error(
                    Some(parent_thread_id),
                    format!("invalid permission request: {error}"),
                );
                let _ = self.send_response(request_id, cancelled_permission_result());
                return;
            }
        };
        if let Some(child) = child.as_ref() {
            self.emit(AcpEvent::Subagent {
                thread_id: parent_thread_id.clone(),
                update: child.agent_update(&parent_thread_id),
            });
        }
        let thread_id = child
            .as_ref()
            .map(|child| child.id.clone())
            .unwrap_or_else(|| parent_thread_id.clone());
        let permission_parent_thread_id = child.as_ref().map(|_| parent_thread_id.clone());
        let permission_mode = self
            .active
            .as_ref()
            .filter(|active| active.thread_id == parent_thread_id)
            .map(|active| active.permission_mode.clone());
        let tool_call = match object.get("toolCall") {
            None => None,
            Some(value) => match value.as_object() {
                Some(value) => Some(value),
                None => {
                    self.error(
                        Some(parent_thread_id),
                        "invalid permission request: toolCall must be an object".to_string(),
                    );
                    let _ = self.send_response(request_id, cancelled_permission_result());
                    return;
                }
            },
        };
        let title = match optional_text(tool_call, "title", MAX_TITLE_BYTES, "permission title") {
            Ok(Some(title)) if !title.trim().is_empty() => title,
            Ok(Some(_)) | Ok(None) => "Agent permission request".to_string(),
            Err(error) => {
                self.error(
                    Some(parent_thread_id),
                    format!("invalid permission request: {error}"),
                );
                let _ = self.send_response(request_id, cancelled_permission_result());
                return;
            }
        };
        let tool = match optional_text(tool_call, "kind", MAX_KIND_BYTES, "permission kind") {
            Ok(Some(tool)) if !tool.trim().is_empty() => tool,
            Ok(Some(_)) | Ok(None) => title.clone(),
            Err(error) => {
                self.error(
                    Some(parent_thread_id),
                    format!("invalid permission request: {error}"),
                );
                let _ = self.send_response(request_id, cancelled_permission_result());
                return;
            }
        };
        let detail = match tool_call.and_then(|call| call.get("rawInput")) {
            Some(value) => match parse_raw_input(Some(value)) {
                Ok(Some(value)) => value,
                Ok(None) => String::new(),
                Err(error) => {
                    self.error(
                        Some(parent_thread_id),
                        format!("invalid permission request: {error}"),
                    );
                    let _ = self.send_response(request_id, cancelled_permission_result());
                    return;
                }
            },
            None => String::new(),
        };
        let options = match parse_permission_options(object.get("options")) {
            Ok(options) => options,
            Err(error) => {
                self.error(
                    Some(parent_thread_id),
                    format!("invalid permission request: {error}"),
                );
                let _ = self.send_response(request_id, cancelled_permission_result());
                return;
            }
        };
        let session_key = session_id.to_string();
        let key = PermissionKey {
            session_id: session_key.clone(),
            request_id: request_id.clone(),
        };
        if self.pending_permissions.contains_key(&key) {
            let _ = self.send_response(request_id, cancelled_permission_result());
            return;
        }
        self.pending_permissions.insert(
            key,
            PendingPermission {
                request_id: request_id.clone(),
                parent_thread_id: Some(parent_thread_id.clone()),
                thread_id: Some(thread_id.clone()),
                options: options.clone(),
            },
        );
        self.emit(AcpEvent::PermissionAsked {
            thread_id: Some(thread_id),
            session_id: Some(session_key),
            permission_mode,
            request_id: request_id.label(),
            title,
            tool,
            detail,
            parent_thread_id: permission_parent_thread_id,
            options,
        });
    }

    fn handle_rpc_result(&mut self, kind: RpcKind, result: Value) {
        match kind {
            RpcKind::Initialize => {
                let version = result.get("protocolVersion").and_then(Value::as_u64);
                if version != Some(1) {
                    self.process_failed(
                        "emma-cli returned an incompatible ACP version".to_string(),
                    );
                    return;
                }
                if let Some(process) = self.process.as_mut() {
                    process.initialized = true;
                }
                self.emit(AcpEvent::Ready);
                self.start_next();
            }
            RpcKind::New(prompt) => {
                let Some(session_id) = result.get("sessionId").and_then(Value::as_str) else {
                    self.error(
                        Some(prompt.thread_id),
                        "emma-cli returned no session ID".to_string(),
                    );
                    return;
                };
                if validate_id(session_id, "session ID").is_err() {
                    self.error(
                        Some(prompt.thread_id),
                        "emma-cli returned an invalid session ID".to_string(),
                    );
                    return;
                }
                self.remember_session(&prompt.thread_id, session_id);
                self.configure_session(prompt);
            }
            RpcKind::Resume(prompt) => self.configure_session(prompt),
            RpcKind::SetMode(prompt) => {
                if let Some(model) = prompt.model.clone() {
                    let Some(session_id) = self.sessions.get(&prompt.thread_id).cloned() else {
                        self.error(
                            Some(prompt.thread_id),
                            "native agent session disappeared".to_string(),
                        );
                        return;
                    };
                    if let Err(error) = self.send_request(
                        "session/set_config_option",
                        json!({
                            "sessionId": session_id,
                            "configId": "model",
                            "value": model
                        }),
                        RpcKind::SetModel(prompt),
                    ) {
                        self.error(None, error);
                    }
                    return;
                }
                self.send_prompt(prompt);
            }
            RpcKind::SetModel(prompt) => self.send_prompt(prompt),
            RpcKind::Prompt(thread_id) => {
                let Some(active) = self.active.take() else {
                    return;
                };
                if active.thread_id != thread_id {
                    return;
                }
                let stop_reason = result
                    .get("stopReason")
                    .and_then(Value::as_str)
                    .map(bounded_text)
                    .unwrap_or_else(|| "end_turn".to_string());
                let usage = parse_usage(result.get("usage"));
                self.emit(AcpEvent::Completed {
                    thread_id: thread_id.clone(),
                    stop_reason: stop_reason.clone(),
                    completed_at: completed_at_millis(),
                    usage: usage.clone(),
                });
                self.emit(AcpEvent::PromptFinished {
                    thread_id,
                    stop_reason,
                    usage,
                });
                self.start_next();
            }
        }
    }

    fn send_prompt(&mut self, prompt: Prompt) {
        let Some(session_id) = self.sessions.get(&prompt.thread_id).cloned() else {
            self.error(
                Some(prompt.thread_id),
                "native agent session disappeared".to_string(),
            );
            return;
        };
        let thread_id = prompt.thread_id.clone();
        if let Err(error) = self.send_request(
            "session/prompt",
            json!({
                "sessionId": session_id,
                "prompt": [{"type": "text", "text": prompt.text}]
            }),
            RpcKind::Prompt(thread_id.clone()),
        ) {
            self.error(Some(thread_id), error);
            return;
        }
        self.active = Some(ActivePrompt {
            thread_id,
            permission_mode: prompt.permission_mode,
            bytes: 0,
        });
    }

    fn configure_session(&mut self, prompt: Prompt) {
        if let Some(session_id) = self.sessions.get(&prompt.thread_id).cloned() {
            if let Err(error) = self.send_request(
                "session/set_mode",
                session_mode_params(&session_id),
                RpcKind::SetMode(prompt.clone()),
            ) {
                self.error(Some(prompt.thread_id), error);
            }
        } else {
            self.error(
                Some(prompt.thread_id),
                "native agent session disappeared".to_string(),
            );
        }
    }

    fn handle_rpc_error(&mut self, kind: RpcKind, error: String) {
        match kind {
            RpcKind::Resume(prompt) => {
                self.forget_session(&prompt.thread_id);
                self.queued.push_front(prompt);
                self.start_next();
            }
            RpcKind::New(prompt) | RpcKind::SetMode(prompt) | RpcKind::SetModel(prompt) => {
                self.error(Some(prompt.thread_id), error);
                self.start_next();
            }
            RpcKind::Prompt(thread_id) => {
                self.active = None;
                self.error(Some(thread_id), error);
                self.start_next();
            }
            RpcKind::Initialize => self.process_failed(error),
        }
    }

    fn send_error_response(
        &self,
        request_id: WireId,
        code: i64,
        message: &str,
    ) -> Result<(), String> {
        let writer = self
            .process
            .as_ref()
            .ok_or_else(|| "emma-cli is not running".to_string())?
            .writer
            .clone();
        writer
            .try_send(Outbound::Message(json!({
                "jsonrpc": "2.0",
                "id": request_id.value(),
                "error": {"code": code, "message": bounded_text(message)}
            })))
            .map_err(|error| format!("could not write emma-cli error response: {error}"))
    }

    fn check_process(&mut self) {
        let result = self
            .process
            .as_mut()
            .map(|process| process.child.try_wait());
        let Some(result) = result else {
            return;
        };
        match result {
            Ok(Some(status)) => self.process_failed(format!("emma-cli exited with {status}")),
            Err(error) => self.process_failed(format!("could not inspect emma-cli: {error}")),
            Ok(None) => {}
        }
    }

    fn touch_pending(&mut self) {
        let now = Instant::now();
        for pending in self.pending.values_mut() {
            pending.last_activity = now;
        }
    }

    fn check_pending_timeouts(&mut self) {
        let now = Instant::now();
        let expired = self.pending.iter().find_map(|(id, pending)| {
            (now.duration_since(pending.last_activity) >= RPC_IDLE_TIMEOUT).then_some(*id)
        });
        let Some(id) = expired else {
            return;
        };
        let Some(pending) = self.pending.remove(&id) else {
            return;
        };
        let message = "emma-cli ACP request timed out".to_string();
        match pending.kind {
            RpcKind::Initialize => self.process_failed(message),
            RpcKind::Resume(prompt) => {
                self.forget_session(&prompt.thread_id);
                self.queued.push_front(prompt);
                self.process_failed(message);
            }
            RpcKind::New(prompt) | RpcKind::SetMode(prompt) | RpcKind::SetModel(prompt) => {
                self.queued.push_front(prompt);
                self.process_failed(message);
            }
            RpcKind::Prompt(thread_id) => {
                self.active = None;
                self.error(Some(thread_id), message);
                self.process_failed("emma-cli prompt request timed out".to_string());
            }
        }
    }

    fn process_failed(&mut self, message: String) {
        let active = self.active.take().map(|active| active.thread_id);
        self.pending.clear();
        self.cancel_pending_permissions();
        self.tool_calls.clear();
        let message = if self.stderr_tail.is_empty() {
            message
        } else {
            format!("{message}: {}", self.stderr_tail)
        };
        self.stderr_tail.clear();
        self.error(active, message);
        self.emit(AcpEvent::ChildExited);
        self.stop_process();
    }

    fn stop_process(&mut self) {
        self.cancel_pending_permissions();
        let Some(mut process) = self.process.take() else {
            return;
        };
        let _ = process.writer.try_send(Outbound::Close);
        let _ = process.child.kill();
        let _ = process.child.wait();
    }

    fn finish_cancelled(&mut self, thread_id: String) {
        self.emit(AcpEvent::Completed {
            thread_id: thread_id.clone(),
            stop_reason: "cancelled".to_string(),
            completed_at: completed_at_millis(),
            usage: AcpUsage::default(),
        });
        self.emit(AcpEvent::PromptFinished {
            thread_id,
            stop_reason: "cancelled".to_string(),
            usage: AcpUsage::default(),
        });
    }

    fn answer_permission(
        &mut self,
        session_id: Option<String>,
        request_id: String,
        option_id: Option<String>,
    ) {
        let session_key = session_id.unwrap_or_default();
        let key = self
            .pending_permissions
            .keys()
            .find(|key| key.session_id == session_key && key.request_id.label() == request_id)
            .cloned();
        let Some(key) = key else {
            return;
        };
        let Some(pending) = self.pending_permissions.remove(&key) else {
            return;
        };
        let selected = option_id.filter(|option_id| {
            pending
                .options
                .iter()
                .any(|option| option.option_id == *option_id)
        });
        let allowed = selected.is_some();
        let result = permission_result(&pending.options, selected);
        match self.send_response(pending.request_id, result) {
            Ok(()) => self.emit(AcpEvent::PermissionResolved {
                thread_id: pending.thread_id,
                request_id,
                allowed,
            }),
            Err(error) => {
                self.error(pending.thread_id, error);
                self.process_failed("emma-cli permission response failed".to_string());
            }
        }
    }

    fn cancel_permissions_for_thread(&mut self, thread_id: &str) {
        let keys = self
            .pending_permissions
            .iter()
            .filter(|(_, pending)| {
                pending.parent_thread_id.as_deref() == Some(thread_id)
                    || pending.thread_id.as_deref() == Some(thread_id)
            })
            .map(|(key, _)| key.clone())
            .collect::<Vec<_>>();
        for key in keys {
            if let Some(pending) = self.pending_permissions.remove(&key) {
                let request_id = pending.request_id.label();
                if self
                    .send_response(pending.request_id, cancelled_permission_result())
                    .is_ok()
                {
                    self.emit(AcpEvent::PermissionResolved {
                        thread_id: pending.thread_id,
                        request_id,
                        allowed: false,
                    });
                }
            }
        }
    }

    fn cancel_pending_permissions(&mut self) {
        let pending = std::mem::take(&mut self.pending_permissions);
        for (_, permission) in pending {
            let request_id = permission.request_id.label();
            if self
                .send_response(permission.request_id, cancelled_permission_result())
                .is_ok()
            {
                self.emit(AcpEvent::PermissionResolved {
                    thread_id: permission.thread_id,
                    request_id,
                    allowed: false,
                });
            }
        }
    }

    fn remember_session(&mut self, thread_id: &str, session_id: &str) {
        if let Some(previous) = self
            .sessions
            .insert(thread_id.to_string(), session_id.to_string())
        {
            self.threads_by_session.remove(&previous);
        }
        self.threads_by_session
            .insert(session_id.to_string(), thread_id.to_string());
        while self.sessions.len() > MAX_SESSIONS {
            let Some(thread_id) = self.sessions.keys().next().cloned() else {
                break;
            };
            self.forget_session(&thread_id);
        }
        save_session_index(&self.session_index, &self.sessions);
    }

    fn forget_session(&mut self, thread_id: &str) {
        if let Some(session_id) = self.sessions.remove(thread_id) {
            self.threads_by_session.remove(&session_id);
        }
        self.tool_calls
            .retain(|(call_thread_id, _), _| call_thread_id != thread_id);
        save_session_index(&self.session_index, &self.sessions);
    }

    fn protocol_error(&mut self, message: String) {
        self.error(None, message);
    }

    fn error(&self, thread_id: Option<String>, message: String) {
        self.emit(AcpEvent::Error {
            thread_id,
            message: bounded_text(&message),
        });
    }

    fn emit(&self, event: AcpEvent) {
        let _ = self.events.send_blocking(event);
    }
}

fn write_loop(mut stdin: impl Write, commands: async_channel::Receiver<Outbound>) {
    while let Ok(command) = commands.recv_blocking() {
        match command {
            Outbound::Message(value) => {
                let Ok(mut encoded) = serde_json::to_vec(&value) else {
                    break;
                };
                encoded.push(b'\n');
                if stdin
                    .write_all(&encoded)
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    break;
                }
            }
            Outbound::Close => break,
        }
    }
}

fn read_loop(stdout: impl std::io::Read, inbound: async_channel::Sender<Inbound>) {
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        let has_line = match read_bounded_line(&mut reader, &mut line) {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                let _ = inbound.send_blocking(Inbound::Eof(format!(
                    "could not read emma-cli output: {error}"
                )));
                return;
            }
        };
        if !has_line {
            let _ = inbound.send_blocking(Inbound::Eof("emma-cli stdout closed".to_string()));
            return;
        }
        while line.last().is_some_and(u8::is_ascii_whitespace) {
            line.pop();
        }
        if line.is_empty() {
            continue;
        }
        let text = match std::str::from_utf8(&line) {
            Ok(text) => text,
            Err(error) => {
                let _ = inbound.send_blocking(Inbound::Eof(format!(
                    "emma-cli output is not UTF-8: {error}"
                )));
                return;
            }
        };
        match serde_json::from_str::<Value>(text) {
            Ok(value) => {
                if inbound.send_blocking(Inbound::Message(value)).is_err() {
                    return;
                }
            }
            Err(error) => {
                let _ = inbound.send_blocking(Inbound::Eof(format!(
                    "could not parse emma-cli output: {error}"
                )));
                return;
            }
        }
    }
}

fn read_bounded_line<R: std::io::Read>(
    reader: &mut BufReader<R>,
    line: &mut Vec<u8>,
) -> io::Result<Option<usize>> {
    line.clear();
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok((!line.is_empty()).then_some(line.len()));
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let length = newline.map_or(buffer.len(), |position| position.saturating_add(1));
        if line.len().saturating_add(length) > MAX_LINE_BYTES.saturating_add(1) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "emma-cli response line is too large",
            ));
        }
        line.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if newline.is_some() {
            return Ok(Some(line.len()));
        }
    }
}

fn stderr_loop(stderr: impl std::io::Read, inbound: async_channel::Sender<Inbound>) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    let mut tail = String::new();
    while reader.read_line(&mut line).is_ok() {
        if line.is_empty() {
            break;
        }
        tail.push_str(&line);
        if tail.len() > 8 * 1024 {
            let start = tail.len().saturating_sub(8 * 1024);
            tail = tail[start..].to_string();
        }
        line.clear();
    }
    let message = tail.trim();
    if !message.is_empty() {
        let _ = inbound.send_blocking(Inbound::Stderr(bounded_text(message)));
    }
}

fn request_value(id: u64, method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","id":id,"method":method,"params":params})
}

fn notification_value(method: &str, params: Value) -> Value {
    json!({"jsonrpc":"2.0","method":method,"params":params})
}

fn session_mode_params(session_id: &str) -> Value {
    json!({"sessionId": session_id, "modeId": ACP_MODE_ID})
}

fn cancelled_permission_result() -> Value {
    json!({"outcome": {"outcome": "cancelled"}})
}

fn permission_result(options: &[AcpPermissionOption], option_id: Option<String>) -> Value {
    let selected =
        option_id.filter(|option_id| options.iter().any(|option| option.option_id == *option_id));
    selected.map_or_else(
        cancelled_permission_result,
        |option_id| json!({"outcome": {"outcome": "selected", "optionId": option_id}}),
    )
}

fn parse_wire_id_value(value: &Value) -> Option<WireId> {
    match value {
        Value::Number(value) => value.as_u64().map(WireId::Number),
        Value::String(value) if !value.is_empty() && value.len() <= MAX_ID_BYTES => {
            Some(WireId::String(value.clone()))
        }
        _ => None,
    }
}

fn update_delta(value: Option<&Value>) -> Option<(bool, String)> {
    let update = value?.as_object()?;
    let thought = update
        .get("sessionUpdate")
        .and_then(Value::as_str)
        .is_some_and(|kind| kind == "agent_thought_chunk");
    let kind = update.get("sessionUpdate").and_then(Value::as_str)?;
    if kind != "agent_message_chunk" && !thought {
        return None;
    }
    let content = update.get("content")?;
    let text = content
        .get("text")
        .and_then(Value::as_str)
        .or_else(|| content.as_str())?;
    Some((thought, text.to_string()))
}

fn parse_text_chunk(update: &Map<String, Value>) -> Result<String, String> {
    let content = update
        .get("content")
        .ok_or_else(|| "content is missing".to_string())?;
    let text = match content {
        Value::String(text) => text.as_str(),
        Value::Object(content) => content
            .get("text")
            .and_then(Value::as_str)
            .ok_or_else(|| "content.text is missing".to_string())?,
        _ => return Err("content must be text or an object".to_string()),
    };
    bounded_string(text, MAX_DELTA_BYTES, "text")
}

fn parse_tool_call(
    update: &Map<String, Value>,
    initial: bool,
    previous: Option<&AcpToolCall>,
) -> Result<AcpToolCall, String> {
    let id = required_id(update, "toolCallId", "tool call ID")?;
    let title = if initial {
        optional_string(update, "title", MAX_TITLE_BYTES, "tool call title")?
            .filter(|title| !title.trim().is_empty())
            .unwrap_or_else(|| "Tool call".to_string())
    } else {
        optional_string(update, "title", MAX_TITLE_BYTES, "tool call title")?
            .filter(|title| !title.trim().is_empty())
            .or_else(|| previous.map(|call| call.title.clone()))
            .unwrap_or_else(|| "Tool call".to_string())
    };
    let kind = optional_string(update, "kind", MAX_KIND_BYTES, "tool call kind")?
        .filter(|kind| !kind.trim().is_empty())
        .or_else(|| previous.map(|call| call.kind.clone()))
        .unwrap_or_else(|| "other".to_string());
    let status = optional_string(update, "status", MAX_KIND_BYTES, "tool call status")?
        .or_else(|| previous.map(|call| call.status.clone()))
        .unwrap_or_else(|| "pending".to_string());
    validate_tool_status(&status)?;
    let tool_name = if update.contains_key("_emma_toolName") {
        optional_string(update, "_emma_toolName", MAX_KIND_BYTES, "tool name")?
            .or_else(|| previous.and_then(|call| call.tool_name.clone()))
    } else if update.contains_key("toolName") {
        optional_string(update, "toolName", MAX_KIND_BYTES, "tool name")?
            .or_else(|| previous.and_then(|call| call.tool_name.clone()))
    } else {
        previous.and_then(|call| call.tool_name.clone())
    };
    let input = if let Some(value) = update.get("rawInput") {
        parse_raw_input(Some(value))?
            .or_else(|| previous.map(|call| call.input.clone()))
            .unwrap_or_default()
    } else {
        previous.map(|call| call.input.clone()).unwrap_or_default()
    };
    let output = if update.contains_key("content") {
        parse_tool_output(update.get("content"))?
            .or_else(|| previous.map(|call| call.output.clone()))
            .unwrap_or_default()
    } else {
        previous.map(|call| call.output.clone()).unwrap_or_default()
    };
    let path = if update.contains_key("_emma_filePath") {
        optional_path(update, "_emma_filePath")?
    } else if update.contains_key("filePath") {
        optional_path(update, "filePath")?
    } else {
        previous.and_then(|call| call.path.clone())
    };
    let mut edit = if update.contains_key("edit") {
        parse_edit_diff(update.get("edit"))?
    } else if update.contains_key("diff") {
        parse_edit_diff(update.get("diff"))?
    } else {
        previous.and_then(|call| call.edit.clone())
    };
    if let Some(edit) = edit.as_mut()
        && edit.path.is_empty()
    {
        if let Some(path) = path.as_deref() {
            edit.path = path.to_string();
        }
    }
    let command_result = if let Some(value) = update.get("command_result") {
        Some(serialize_bounded(
            value,
            MAX_METADATA_TEXT_BYTES,
            "command result",
        )?)
    } else {
        previous.and_then(|call| call.command_result.clone())
    };
    Ok(AcpToolCall {
        id,
        title,
        kind,
        tool_name,
        status,
        input,
        output,
        path,
        edit,
        command_result,
    })
}

fn parse_tool_output(value: Option<&Value>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(blocks) = value.as_array() else {
        return Err("tool output content must be an array".to_string());
    };
    if blocks.len() > MAX_PLAN_ITEMS {
        return Err("tool output has too many blocks".to_string());
    }
    let mut parts = Vec::new();
    for block in blocks {
        let Some(block) = block.as_object() else {
            continue;
        };
        let inner = block.get("content").and_then(Value::as_object);
        let text = inner
            .and_then(|content| content.get("text"))
            .and_then(|text| {
                (inner
                    .and_then(|content| content.get("type"))
                    .and_then(Value::as_str)
                    == Some("text"))
                .then(|| text.as_str())
                .flatten()
            })
            .or_else(|| {
                (block.get("type").and_then(Value::as_str) == Some("text"))
                    .then(|| block.get("text").and_then(Value::as_str))
                    .flatten()
            });
        if let Some(text) = text {
            parts.push(bounded_string(text, MAX_TOOL_OUTPUT_BYTES, "tool output")?);
        }
    }
    if parts.is_empty() {
        return Ok(None);
    }
    let output = parts.join("\n");
    let output = unwrap_tool_output(output);
    Ok(Some(bounded_string(
        &output,
        MAX_TOOL_OUTPUT_BYTES,
        "tool output",
    )?))
}

fn unwrap_tool_output(text: String) -> String {
    if !text.starts_with('{') {
        return text;
    }
    let Ok(Value::Object(object)) = serde_json::from_str::<Value>(&text) else {
        return text;
    };
    if object.get("tool").and_then(Value::as_str).is_none() {
        return text;
    }
    let Some(content) = object
        .get("result")
        .and_then(Value::as_object)
        .and_then(|result| result.get("content"))
        .and_then(Value::as_array)
    else {
        return text;
    };
    let parts = content
        .iter()
        .filter_map(|value| {
            let object = value.as_object()?;
            (object.get("type").and_then(Value::as_str) == Some("text"))
                .then(|| object.get("text").and_then(Value::as_str))
                .flatten()
        })
        .collect::<Vec<_>>();
    if parts.is_empty() {
        text
    } else {
        parts.join("\n")
    }
}

fn parse_edit_diff(value: Option<&Value>) -> Result<Option<AcpEditDiff>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let Some(object) = value.as_object() else {
        return Err("edit must be an object".to_string());
    };
    let path = optional_string(object, "path", MAX_PATH_BYTES, "edit path")?.unwrap_or_default();
    let added =
        optional_alias_u64(object, &["added", "additions"], "edit additions")?.unwrap_or_default();
    let removed = optional_alias_u64(object, &["removed", "deletions"], "edit deletions")?
        .unwrap_or_default();
    let hunk_value = object.get("hunks").or_else(|| object.get("lines"));
    let hunks = match hunk_value {
        None => Vec::new(),
        Some(value) => {
            let values = value
                .as_array()
                .ok_or_else(|| "edit hunks must be an array".to_string())?;
            if values.len() > MAX_PLAN_ITEMS {
                return Err("edit has too many hunks".to_string());
            }
            values
                .iter()
                .map(parse_diff_line)
                .collect::<Result<Vec<_>, _>>()?
        }
    };
    Ok(Some(AcpEditDiff {
        path,
        added,
        removed,
        hunks,
    }))
}

fn parse_diff_line(value: &Value) -> Result<AcpDiffLine, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "diff line must be an object".to_string())?;
    let kind = optional_alias_string(
        object,
        &["kind", "type", "op"],
        MAX_KIND_BYTES,
        "diff line kind",
    )?
    .unwrap_or_else(|| "context".to_string());
    let kind = match kind.as_str() {
        "context" | "unchanged" | " " => "context",
        "added" | "add" | "+" => "added",
        "removed" | "remove" | "deleted" | "delete" | "-" => "removed",
        _ => return Err("diff line kind is invalid".to_string()),
    };
    let line = optional_alias_u64(
        object,
        &["line", "lineNumber", "oldLine", "newLine"],
        "diff line number",
    )?
    .unwrap_or_default();
    let text = required_alias_string(
        object,
        &["text", "content"],
        MAX_METADATA_TEXT_BYTES,
        "diff line text",
    )?;
    Ok(AcpDiffLine {
        kind: kind.to_string(),
        line,
        text,
    })
}

fn parse_plan(update: &Map<String, Value>) -> Result<AcpPlan, String> {
    let source = nested_object(update, &["plan"])?.unwrap_or(update);
    let id = optional_alias_string(source, &["planId", "id"], MAX_ID_BYTES, "plan ID")?
        .unwrap_or_else(|| "plan".to_string());
    validate_id(&id, "plan ID")?;
    let title = optional_string(source, "title", MAX_TITLE_BYTES, "plan title")?
        .unwrap_or_else(|| id.clone());
    let goal =
        optional_string(source, "goal", MAX_METADATA_TEXT_BYTES, "plan goal")?.unwrap_or_default();
    let updated_at =
        optional_scalar_string(source, "updatedAt", MAX_TITLE_BYTES, "plan timestamp")?
            .unwrap_or_default();
    let values = source
        .get("steps")
        .or_else(|| source.get("entries"))
        .or_else(|| update.get("steps"))
        .or_else(|| update.get("entries"));
    let steps = parse_array(values, MAX_PLAN_ITEMS, "plan steps")?
        .map(|values| {
            values
                .iter()
                .enumerate()
                .map(|(index, value)| parse_plan_step(value, index))
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();
    Ok(AcpPlan {
        id,
        title,
        goal,
        updated_at,
        steps,
    })
}

fn parse_plan_step(value: &Value, index: usize) -> Result<AcpPlanStep, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "plan step must be an object".to_string())?;
    let fallback_id = format!("step-{}", index.saturating_add(1));
    let id = optional_alias_string(object, &["id", "stepId"], MAX_ID_BYTES, "plan step ID")?
        .unwrap_or(fallback_id);
    validate_id(&id, "plan step ID")?;
    let title = optional_alias_string(
        object,
        &["title", "name"],
        MAX_TITLE_BYTES,
        "plan step title",
    )?
    .unwrap_or_else(|| id.clone());
    let status = optional_string(object, "status", MAX_KIND_BYTES, "plan step status")?
        .unwrap_or_else(|| "pending".to_string());
    let needs = parse_string_array(
        object.get("needs"),
        MAX_PLAN_ITEMS,
        MAX_ID_BYTES,
        "plan dependencies",
    )?
    .unwrap_or_default();
    for need in &needs {
        validate_id(need, "plan dependency ID")?;
    }
    let brief = optional_string(object, "brief", MAX_METADATA_TEXT_BYTES, "plan step brief")?
        .unwrap_or_default();
    let result = optional_string(
        object,
        "result",
        MAX_METADATA_TEXT_BYTES,
        "plan step result",
    )?;
    Ok(AcpPlanStep {
        id,
        title,
        status,
        needs,
        brief,
        result,
    })
}

fn parse_task_list(update: &Map<String, Value>) -> Result<AcpTaskList, String> {
    let source = nested_object(update, &["taskList"])?.unwrap_or(update);
    let id = optional_alias_string(
        source,
        &["taskListId", "listId", "id"],
        MAX_ID_BYTES,
        "task list ID",
    )?
    .unwrap_or_else(|| "tasks".to_string());
    validate_id(&id, "task list ID")?;
    let title = optional_string(source, "title", MAX_TITLE_BYTES, "task list title")?
        .unwrap_or_else(|| id.clone());
    let goal = optional_string(source, "goal", MAX_METADATA_TEXT_BYTES, "task list goal")?
        .unwrap_or_default();
    let updated_at =
        optional_scalar_string(source, "updatedAt", MAX_TITLE_BYTES, "task list timestamp")?
            .unwrap_or_default();
    let values = source
        .get("tasks")
        .or_else(|| source.get("entries"))
        .or_else(|| update.get("tasks"))
        .or_else(|| update.get("entries"));
    let tasks = if let Some(values) = parse_array(values, MAX_TASK_ITEMS, "task list tasks")? {
        let mut tasks = Vec::new();
        for (index, value) in values.iter().enumerate() {
            parse_task_tree(value, index, 0, None, &mut tasks)?;
        }
        tasks
    } else {
        Vec::new()
    };
    Ok(AcpTaskList {
        id,
        title,
        goal,
        updated_at,
        tasks,
    })
}

fn parse_task(value: &Value, index: usize) -> Result<AcpTask, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "task must be an object".to_string())?;
    let fallback_id = format!("task-{}", index.saturating_add(1));
    let id = optional_alias_string(object, &["id", "taskId"], MAX_ID_BYTES, "task ID")?
        .unwrap_or(fallback_id);
    validate_id(&id, "task ID")?;
    let title = optional_alias_string(object, &["title", "name"], MAX_TITLE_BYTES, "task title")?
        .unwrap_or_else(|| id.clone());
    let status = optional_string(object, "status", MAX_KIND_BYTES, "task status")?
        .unwrap_or_else(|| "pending".to_string());
    let parent_id = optional_alias_string(
        object,
        &["parentId", "parent_id"],
        MAX_ID_BYTES,
        "task parent ID",
    )?;
    if let Some(parent_id) = parent_id.as_deref() {
        validate_id(parent_id, "task parent ID")?;
    }
    let depth = optional_u64(object, "depth", "task depth")?.unwrap_or_default();
    if depth > 256 {
        return Err("task depth is too large".to_string());
    }
    Ok(AcpTask {
        id,
        title,
        status,
        parent_id,
        depth,
    })
}

fn parse_task_tree(
    value: &Value,
    index: usize,
    depth: u64,
    parent_id: Option<&str>,
    output: &mut Vec<AcpTask>,
) -> Result<(), String> {
    if output.len() >= MAX_TASK_ITEMS {
        return Err("task list has too many entries".to_string());
    }
    let object = value
        .as_object()
        .ok_or_else(|| "task must be an object".to_string())?;
    let mut task = parse_task(value, index)?;
    if !object.contains_key("depth") {
        task.depth = depth;
    }
    if parent_id.is_some() {
        task.parent_id = parent_id.map(str::to_string);
    }
    let task_id = task.id.clone();
    output.push(task);
    let children = object.get("subtasks").or_else(|| object.get("children"));
    let Some(children) = children else {
        return Ok(());
    };
    let children = parse_array(Some(children), MAX_TASK_ITEMS, "task subtasks")?
        .ok_or_else(|| "task subtasks are missing".to_string())?;
    for (child_index, child) in children.iter().enumerate() {
        parse_task_tree(
            child,
            child_index,
            depth.saturating_add(1),
            Some(&task_id),
            output,
        )?;
    }
    Ok(())
}

fn parse_timeline_span(update: &Map<String, Value>) -> Result<AcpTimelineSpan, String> {
    let source = nested_object(update, &["span", "timeline"])?.unwrap_or(update);
    let id = optional_alias_string(
        source,
        &["id", "spanId", "activityId"],
        MAX_ID_BYTES,
        "timeline ID",
    )?
    .unwrap_or_else(|| "activity".to_string());
    validate_id(&id, "timeline ID")?;
    let parent_id = optional_alias_string(
        source,
        &["parentId", "parent_id"],
        MAX_ID_BYTES,
        "timeline parent ID",
    )?;
    if let Some(parent_id) = parent_id.as_deref() {
        validate_id(parent_id, "timeline parent ID")?;
    }
    let name = optional_alias_string(
        source,
        &["name", "title", "activity"],
        MAX_TITLE_BYTES,
        "timeline name",
    )?
    .unwrap_or_else(|| id.clone());
    let kind = optional_string(source, "kind", MAX_KIND_BYTES, "timeline kind")?
        .unwrap_or_else(|| "activity".to_string());
    let started_at =
        optional_alias_u64(source, &["startedAt", "start", "started"], "timeline start")?
            .unwrap_or_default();
    let ended_at = optional_alias_u64(source, &["endedAt", "end", "ended"], "timeline end")?;
    let status = optional_string(source, "status", MAX_KIND_BYTES, "timeline status")?
        .unwrap_or_else(|| "running".to_string());
    let input = optional_serialized(
        source.get("input"),
        MAX_METADATA_TEXT_BYTES,
        "timeline input",
    )?;
    let output = optional_serialized(
        source.get("output"),
        MAX_METADATA_TEXT_BYTES,
        "timeline output",
    )?;
    let tokens = optional_u64(source, "tokens", "timeline tokens")?;
    Ok(AcpTimelineSpan {
        id,
        parent_id,
        name,
        kind,
        started_at,
        ended_at,
        status,
        input,
        output,
        tokens,
    })
}

fn parse_completion_menu(update: &Map<String, Value>) -> Result<Option<AcpCompletionMenu>, String> {
    let value = update.get("menu").or_else(|| update.get("completion"));
    let Some(value) = value else {
        return parse_completion_menu_object(update).map(Some);
    };
    if value.is_null() {
        return Ok(None);
    }
    let object = value
        .as_object()
        .ok_or_else(|| "completion menu must be an object".to_string())?;
    parse_completion_menu_object(object).map(Some)
}

fn parse_completion_menu_object(object: &Map<String, Value>) -> Result<AcpCompletionMenu, String> {
    let sigil = optional_string(object, "sigil", MAX_KIND_BYTES, "completion sigil")?
        .unwrap_or_else(|| "/".to_string());
    let sigil = match sigil.as_str() {
        "/" | "slash" => "/",
        "@" | "at" => "@",
        _ => return Err("completion sigil is invalid".to_string()),
    }
    .to_string();
    let query =
        optional_string(object, "query", MAX_TITLE_BYTES, "completion query")?.unwrap_or_default();
    let items = parse_array(
        object.get("items"),
        MAX_AVAILABLE_COMMANDS,
        "completion items",
    )?
    .map(|values| {
        values
            .iter()
            .map(parse_completion_item)
            .collect::<Result<Vec<_>, _>>()
    })
    .transpose()?
    .unwrap_or_default();
    let active = optional_u64(object, "active", "completion active item")?
        .unwrap_or_default()
        .min(items.len() as u64);
    Ok(AcpCompletionMenu {
        sigil,
        query,
        items,
        active,
    })
}

fn parse_completion_item(value: &Value) -> Result<AcpCompletionItem, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "completion item must be an object".to_string())?;
    let id = required_alias_string(object, &["id", "value"], MAX_ID_BYTES, "completion item ID")?;
    validate_id(&id, "completion item ID")?;
    let name = required_alias_string(
        object,
        &["name", "label"],
        MAX_TITLE_BYTES,
        "completion item name",
    )?;
    let kind = optional_string(object, "kind", MAX_KIND_BYTES, "completion item kind")?
        .unwrap_or_else(|| "other".to_string());
    let detail = optional_alias_string(
        object,
        &["detail", "description"],
        MAX_METADATA_TEXT_BYTES,
        "completion item detail",
    )?
    .unwrap_or_default();
    Ok(AcpCompletionItem {
        id,
        name,
        kind,
        detail,
    })
}

fn parse_available_commands(
    update: &Map<String, Value>,
) -> Result<Vec<AcpAvailableCommand>, String> {
    let value = update
        .get("availableCommands")
        .ok_or_else(|| "available commands are missing".to_string())?;
    let values = value
        .as_array()
        .ok_or_else(|| "available commands must be an array".to_string())?;
    if values.len() > MAX_AVAILABLE_COMMANDS {
        return Err("too many available commands".to_string());
    }
    values
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let raw = serialize_bounded(value, MAX_METADATA_TEXT_BYTES, "available command")?;
            if let Some(name) = value.as_str() {
                let name = bounded_string(name, MAX_TITLE_BYTES, "available command")?;
                return Ok(AcpAvailableCommand {
                    id: format!("command-{}", index.saturating_add(1)),
                    name,
                    detail: String::new(),
                    raw,
                });
            }
            let object = value
                .as_object()
                .ok_or_else(|| "available command must be a string or object".to_string())?;
            let id = required_alias_string(
                object,
                &["id", "name", "command"],
                MAX_ID_BYTES,
                "available command ID",
            )?;
            validate_id(&id, "available command ID")?;
            let name = optional_alias_string(
                object,
                &["name", "label", "command"],
                MAX_TITLE_BYTES,
                "available command name",
            )?
            .unwrap_or_else(|| id.clone());
            let detail = optional_alias_string(
                object,
                &["detail", "description"],
                MAX_METADATA_TEXT_BYTES,
                "available command detail",
            )?
            .unwrap_or_default();
            Ok(AcpAvailableCommand {
                id,
                name,
                detail,
                raw,
            })
        })
        .collect()
}

fn parse_agent_update(
    update: &Map<String, Value>,
    parent_id: Option<&str>,
) -> Result<AcpAgentUpdate, String> {
    let source = nested_object(update, &["agent", "subagent"])?.unwrap_or(update);
    let child = parse_child_tag(update)?;
    let id = optional_alias_string(
        source,
        &["id", "agentId", "childId"],
        MAX_CHILD_ID_BYTES,
        "subagent ID",
    )?
    .or_else(|| child.as_ref().map(|child| child.id.clone()))
    .ok_or_else(|| "subagent ID is missing".to_string())?;
    validate_id(&id, "subagent ID")?;
    let title = optional_alias_string(
        source,
        &["title", "name"],
        MAX_TITLE_BYTES,
        "subagent title",
    )?
    .or_else(|| child.as_ref().map(|child| child.title.clone()))
    .unwrap_or_else(|| "Subagent".to_string());
    let brief = optional_string(source, "brief", MAX_METADATA_TEXT_BYTES, "subagent brief")?
        .unwrap_or_else(|| title.clone());
    let color = optional_string(source, "color", MAX_KIND_BYTES, "subagent color")?;
    let status = optional_string(source, "status", MAX_KIND_BYTES, "subagent status")?
        .or_else(|| child.as_ref().map(|child| child.status.clone()))
        .unwrap_or_else(|| "running".to_string());
    let status = match status.as_str() {
        "ended" | "completed" => "done".to_string(),
        _ => status,
    };
    validate_agent_status(&status)?;
    let model = optional_string(source, "model", MAX_MODEL_BYTES, "subagent model")?;
    let effort = optional_string(source, "effort", MAX_KIND_BYTES, "subagent effort")?;
    let activity = optional_string(
        source,
        "activity",
        MAX_METADATA_TEXT_BYTES,
        "subagent activity",
    )?;
    let prompt = optional_string(source, "prompt", MAX_METADATA_TEXT_BYTES, "subagent prompt")?;
    let tool = optional_bool(source, "tool", "subagent tool")?.unwrap_or(false);
    let started_at =
        optional_alias_u64(source, &["startedAt", "start"], "subagent start")?.unwrap_or_default();
    let ended_at = optional_alias_u64(source, &["endedAt", "end"], "subagent end")?;
    let steps = optional_u64(source, "steps", "subagent steps")?.unwrap_or_default();
    let tool_calls = optional_u64(source, "toolCalls", "subagent tool calls")?.unwrap_or_default();
    let input_tokens =
        optional_u64(source, "inputTokens", "subagent input tokens")?.unwrap_or_default();
    let output_tokens =
        optional_u64(source, "outputTokens", "subagent output tokens")?.unwrap_or_default();
    let generation_ms =
        optional_u64(source, "generationMs", "subagent generation time")?.unwrap_or_default();
    let error = optional_string(source, "error", MAX_METADATA_TEXT_BYTES, "subagent error")?;
    Ok(AcpAgentUpdate {
        id,
        parent_id: parent_id.map(str::to_string),
        title,
        brief,
        color,
        status,
        model,
        effort,
        activity,
        prompt,
        tool,
        started_at,
        ended_at,
        steps,
        tool_calls,
        input_tokens,
        output_tokens,
        generation_ms,
        error,
    })
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct AcpChildTag {
    id: String,
    title: String,
    status: String,
}

impl AcpChildTag {
    fn agent_update(&self, parent_id: &str) -> AcpAgentUpdate {
        AcpAgentUpdate {
            id: self.id.clone(),
            parent_id: Some(parent_id.to_string()),
            title: self.title.clone(),
            brief: self.title.clone(),
            color: None,
            status: self.status.clone(),
            model: None,
            effort: None,
            activity: None,
            prompt: None,
            tool: false,
            started_at: 0,
            ended_at: (self.status == "done").then(completed_at_millis),
            steps: 0,
            tool_calls: 0,
            input_tokens: 0,
            output_tokens: 0,
            generation_ms: 0,
            error: None,
        }
    }
}

fn parse_child_tag(value: &Map<String, Value>) -> Result<Option<AcpChildTag>, String> {
    let Some(meta_value) = value.get("_meta") else {
        return Ok(None);
    };
    let meta = meta_value
        .as_object()
        .ok_or_else(|| "_meta must be an object".to_string())?;
    let Some(fx_value) = meta.get("fx") else {
        return Ok(None);
    };
    let fx = fx_value
        .as_object()
        .ok_or_else(|| "_meta.fx must be an object".to_string())?;
    let Some(child_value) = fx.get("child") else {
        return Ok(None);
    };
    if child_value.is_null() {
        return Ok(None);
    }
    let child = child_value
        .as_object()
        .ok_or_else(|| "child metadata must be an object".to_string())?;
    let id = required_string(child, "id", MAX_CHILD_ID_BYTES, "child ID")?;
    validate_id(&id, "child ID")?;
    let title = optional_string(child, "title", MAX_TITLE_BYTES, "child title")?
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| "Subagent".to_string());
    let state = optional_string(child, "state", MAX_KIND_BYTES, "child state")?
        .unwrap_or_else(|| "running".to_string());
    let status = match state.as_str() {
        "running" => "running",
        "ended" | "done" => "done",
        _ => return Err("child state is invalid".to_string()),
    };
    Ok(Some(AcpChildTag {
        id,
        title,
        status: status.to_string(),
    }))
}

fn parse_fx<'a>(update: &'a Map<String, Value>) -> Result<Option<&'a Map<String, Value>>, String> {
    let Some(meta_value) = update.get("_meta") else {
        return Ok(None);
    };
    let meta = meta_value
        .as_object()
        .ok_or_else(|| "_meta must be an object".to_string())?;
    let Some(fx_value) = meta.get("fx") else {
        return Ok(None);
    };
    let fx = fx_value
        .as_object()
        .ok_or_else(|| "_meta.fx must be an object".to_string())?;
    Ok(Some(fx))
}

fn parse_usage_strict(value: &Value) -> Result<AcpUsage, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "turn usage must be an object".to_string())?;
    Ok(AcpUsage {
        input_tokens: optional_u64(object, "inputTokens", "input token count")?.unwrap_or_default(),
        output_tokens: optional_u64(object, "outputTokens", "output token count")?
            .unwrap_or_default(),
        cache_input_tokens: optional_u64(object, "cacheInputTokens", "cache input token count")?,
        cache_read_tokens: optional_u64(object, "cacheReadTokens", "cache read token count")?,
        cache_write_tokens: optional_u64(object, "cacheWriteTokens", "cache write token count")?,
        cost_micro_usd: optional_u64(object, "costMicroUsd", "cost")?,
    })
}

fn parse_context_experiment(value: &Value) -> Result<AcpContextExperiment, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "context experiment must be an object".to_string())?;
    Ok(AcpContextExperiment {
        pruned_results: optional_u64(object, "prunedResults", "pruned result count")?
            .unwrap_or_default(),
        reinjected: optional_bool(object, "reinjected", "reinjected flag")?.unwrap_or(false),
        saved_tokens: optional_u64(object, "savedTokens", "saved token count")?.unwrap_or_default(),
        added_tokens: optional_u64(object, "addedTokens", "added token count")?.unwrap_or_default(),
    })
}

fn parse_context(value: &Value) -> Result<AcpContext, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "context breakdown must be an object".to_string())?;
    Ok(AcpContext {
        system_prompt_bytes: optional_u64(object, "systemPromptBytes", "system prompt bytes")?
            .unwrap_or_default(),
        system_tools_bytes: optional_u64(object, "systemToolsBytes", "system tool bytes")?
            .unwrap_or_default(),
        mcp_tools_bytes: optional_u64(object, "mcpToolsBytes", "MCP tool bytes")?
            .unwrap_or_default(),
        skills_bytes: optional_u64(object, "skillsBytes", "skill bytes")?.unwrap_or_default(),
        memory_bytes: optional_u64(object, "memoryBytes", "memory bytes")?.unwrap_or_default(),
    })
}

fn parse_routed_model(value: &Value) -> Result<(String, bool), String> {
    let object = value
        .as_object()
        .ok_or_else(|| "routed model must be an object".to_string())?;
    let model = required_string(object, "model", MAX_ROUTED_MODEL_BYTES, "routed model")?;
    if model.trim().is_empty() {
        return Err("routed model is empty".to_string());
    }
    let fell_back = optional_bool(object, "fellBack", "model fallback flag")?.unwrap_or(false);
    Ok((model, fell_back))
}

fn parse_recovery(value: &Value) -> Result<AcpRecovery, String> {
    let object = value
        .as_object()
        .ok_or_else(|| "model recovery must be an object".to_string())?;
    let state = optional_string(object, "state", MAX_KIND_BYTES, "recovery state")?
        .unwrap_or_else(|| "active".to_string());
    if !matches!(state.as_str(), "active" | "paused" | "recovered") {
        return Err("recovery state is invalid".to_string());
    }
    let message = required_string(
        object,
        "message",
        MAX_METADATA_TEXT_BYTES,
        "recovery message",
    )?;
    if message.trim().is_empty() {
        return Err("recovery message is empty".to_string());
    }
    Ok(AcpRecovery {
        state,
        kind: optional_string(object, "kind", MAX_KIND_BYTES, "recovery kind")?,
        cause: optional_string(object, "cause", MAX_KIND_BYTES, "recovery cause")?,
        action: optional_string(object, "action", MAX_KIND_BYTES, "recovery action")?,
        required_action: optional_string(
            object,
            "requiredAction",
            MAX_KIND_BYTES,
            "required recovery action",
        )?,
        attempt: optional_u64(object, "attempt", "recovery attempt")?,
        attempt_limit: optional_u64(object, "attemptLimit", "recovery attempt limit")?,
        delay_seconds: optional_u64(object, "delaySeconds", "recovery delay")?,
        durable: optional_bool(object, "durable", "recovery durability")?.unwrap_or(false),
        message,
    })
}

fn recovery_line(recovery: &AcpRecovery) -> String {
    let attempt = match (recovery.attempt, recovery.attempt_limit) {
        (Some(attempt), Some(limit)) if limit > 0 => format!(" (attempt {attempt} of {limit})"),
        _ => String::new(),
    };
    let wait = recovery
        .delay_seconds
        .filter(|delay| *delay > 0)
        .map_or_else(String::new, |delay| format!(", retrying in {delay}s"));
    format!("{}{attempt}{wait}", recovery.message)
}

fn parse_raw_input(value: Option<&Value>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(text) = value.as_str() {
        return Ok(Some(bounded_string(
            text,
            MAX_RAW_INPUT_BYTES,
            "raw input",
        )?));
    }
    Ok(Some(serialize_bounded(
        value,
        MAX_RAW_INPUT_BYTES,
        "raw input",
    )?))
}

fn parse_permission_options(value: Option<&Value>) -> Result<Vec<AcpPermissionOption>, String> {
    let Some(value) = value else {
        return Ok(Vec::new());
    };
    let values = value
        .as_array()
        .ok_or_else(|| "permission options must be an array".to_string())?;
    if values.len() > MAX_PERMISSION_OPTIONS {
        return Err("too many permission options".to_string());
    }
    values
        .iter()
        .map(|value| {
            let object = value
                .as_object()
                .ok_or_else(|| "permission option must be an object".to_string())?;
            let option_id = required_alias_string(
                object,
                &["optionId", "id"],
                MAX_PERMISSION_OPTION_ID_BYTES,
                "permission option ID",
            )?;
            if option_id.is_empty() || !option_id.is_ascii() {
                return Err("permission option ID is invalid".to_string());
            }
            let name = optional_string(object, "name", MAX_TITLE_BYTES, "permission option name")?
                .unwrap_or_else(|| option_id.clone());
            let kind = optional_string(object, "kind", MAX_KIND_BYTES, "permission option kind")?
                .unwrap_or_else(|| "other".to_string());
            Ok(AcpPermissionOption {
                option_id,
                name,
                kind,
            })
        })
        .collect()
}

fn validate_tool_status(value: &str) -> Result<(), String> {
    if matches!(
        value,
        "pending" | "in_progress" | "completed" | "failed" | "cancelled"
    ) {
        Ok(())
    } else {
        Err("tool call status is invalid".to_string())
    }
}

fn validate_agent_status(value: &str) -> Result<(), String> {
    if matches!(value, "running" | "waiting" | "done" | "failed" | "stopped") {
        Ok(())
    } else {
        Err("subagent status is invalid".to_string())
    }
}

fn nested_object<'a>(
    object: &'a Map<String, Value>,
    keys: &[&str],
) -> Result<Option<&'a Map<String, Value>>, String> {
    for key in keys {
        let Some(value) = object.get(*key) else {
            continue;
        };
        if value.is_null() {
            return Ok(None);
        }
        return value
            .as_object()
            .map(Some)
            .ok_or_else(|| format!("{key} must be an object"));
    }
    Ok(None)
}

fn parse_array<'a>(
    value: Option<&'a Value>,
    limit: usize,
    label: &str,
) -> Result<Option<&'a Vec<Value>>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let values = value
        .as_array()
        .ok_or_else(|| format!("{label} must be an array"))?;
    if values.len() > limit {
        return Err(format!("{label} has too many entries"));
    }
    Ok(Some(values))
}

fn parse_string_array(
    value: Option<&Value>,
    limit: usize,
    max: usize,
    label: &str,
) -> Result<Option<Vec<String>>, String> {
    let Some(values) = parse_array(value, limit, label)? else {
        return Ok(None);
    };
    values
        .iter()
        .map(|value| {
            let text = value
                .as_str()
                .ok_or_else(|| format!("{label} entries must be strings"))?;
            bounded_string(text, max, label)
        })
        .collect::<Result<Vec<_>, _>>()
        .map(Some)
}

fn required_id(object: &Map<String, Value>, key: &str, label: &str) -> Result<String, String> {
    let value = required_string(object, key, MAX_ID_BYTES, label)?;
    validate_id(&value, label)?;
    Ok(value)
}

fn required_alias_string(
    object: &Map<String, Value>,
    keys: &[&str],
    max: usize,
    label: &str,
) -> Result<String, String> {
    let value = keys
        .iter()
        .find_map(|key| object.get(*key))
        .ok_or_else(|| format!("{label} is missing"))?;
    parse_string_value(Some(value), max, label)?.ok_or_else(|| format!("{label} is missing"))
}

fn required_string(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
    label: &str,
) -> Result<String, String> {
    parse_string_value(object.get(key), max, label)?.ok_or_else(|| format!("{label} is missing"))
}

fn optional_string(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    parse_string_value(object.get(key), max, label)
}

fn optional_text(
    object: Option<&Map<String, Value>>,
    key: &str,
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    object.map_or(Ok(None), |object| optional_string(object, key, max, label))
}

fn optional_alias_string(
    object: &Map<String, Value>,
    keys: &[&str],
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    let value = keys.iter().find_map(|key| object.get(*key));
    parse_string_value(value, max, label)
}

fn optional_scalar_string(
    object: &Map<String, Value>,
    key: &str,
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    match value {
        Value::String(value) => Ok(Some(bounded_string(value, max, label)?)),
        Value::Number(value) => Ok(Some(bounded_string(&value.to_string(), max, label)?)),
        Value::Null => Ok(None),
        _ => Err(format!("{label} must be a string or number")),
    }
}

fn parse_string_value(
    value: Option<&Value>,
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        Value::String(value) => Ok(Some(bounded_string(value, max, label)?)),
        Value::Null => Ok(None),
        _ => Err(format!("{label} must be a string")),
    }
}

fn bounded_string(value: &str, max: usize, label: &str) -> Result<String, String> {
    if value.len() > max {
        Err(format!("{label} is too large"))
    } else {
        Ok(value.to_string())
    }
}

fn serialize_bounded(value: &Value, max: usize, label: &str) -> Result<String, String> {
    let text = serde_json::to_string(value).map_err(|_| format!("{label} could not be encoded"))?;
    bounded_string(&text, max, label)
}

fn optional_serialized(
    value: Option<&Value>,
    max: usize,
    label: &str,
) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    if value.is_null() {
        return Ok(None);
    }
    if let Some(value) = value.as_str() {
        return Ok(Some(bounded_string(value, max, label)?));
    }
    Ok(Some(serialize_bounded(value, max, label)?))
}

fn optional_path(object: &Map<String, Value>, key: &str) -> Result<Option<String>, String> {
    let value = optional_string(object, key, MAX_PATH_BYTES, "tool file path")?;
    if value.as_deref().is_some_and(|value| value.contains('\0')) {
        return Err("tool file path contains NUL".to_string());
    }
    Ok(value)
}

fn optional_u64(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<u64>, String> {
    parse_u64_value(object.get(key), label)
}

fn optional_alias_u64(
    object: &Map<String, Value>,
    keys: &[&str],
    label: &str,
) -> Result<Option<u64>, String> {
    let value = keys.iter().find_map(|key| object.get(*key));
    parse_u64_value(value, label)
}

fn parse_u64_value(value: Option<&Value>, label: &str) -> Result<Option<u64>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    match value {
        Value::Number(value) => value
            .as_u64()
            .map(Some)
            .ok_or_else(|| format!("{label} must be a non-negative integer")),
        Value::Null => Ok(None),
        _ => Err(format!("{label} must be a non-negative integer")),
    }
}

fn required_u64(object: &Map<String, Value>, key: &str) -> Result<u64, String> {
    optional_u64(object, key, key)?.ok_or_else(|| format!("{key} is missing"))
}

fn optional_bool(
    object: &Map<String, Value>,
    key: &str,
    label: &str,
) -> Result<Option<bool>, String> {
    let Some(value) = object.get(key) else {
        return Ok(None);
    };
    match value {
        Value::Bool(value) => Ok(Some(*value)),
        Value::Null => Ok(None),
        _ => Err(format!("{label} must be a boolean")),
    }
}

fn required_bool(object: &Map<String, Value>, key: &str) -> Result<bool, String> {
    optional_bool(object, key, key)?.ok_or_else(|| format!("{key} is missing"))
}

fn completed_at_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |duration| {
            duration.as_millis().min(u128::from(u64::MAX)) as u64
        })
}

fn parse_usage(value: Option<&Value>) -> AcpUsage {
    let Some(object) = value.and_then(Value::as_object) else {
        return AcpUsage::default();
    };
    AcpUsage {
        input_tokens: object
            .get("inputTokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        output_tokens: object
            .get("outputTokens")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        cache_input_tokens: object.get("cacheInputTokens").and_then(Value::as_u64),
        cache_read_tokens: object.get("cacheReadTokens").and_then(Value::as_u64),
        cache_write_tokens: object.get("cacheWriteTokens").and_then(Value::as_u64),
        cost_micro_usd: object.get("costMicroUsd").and_then(Value::as_u64),
    }
}

fn rpc_error(value: &Value) -> String {
    value
        .get("message")
        .and_then(Value::as_str)
        .map(bounded_text)
        .unwrap_or_else(|| "ACP request failed".to_string())
}

fn bounded_text(value: &str) -> String {
    value.chars().take(MAX_ERROR_CHARS).collect()
}

fn validate_id(value: &str, label: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_ID_BYTES || !value.is_ascii() || value.contains('\0') {
        return Err(format!("{label} is invalid"));
    }
    Ok(())
}

fn validate_mode_id(value: &str) -> Result<(), String> {
    if matches!(value, "plan" | "ask" | "acceptEdits" | "auto" | "full") {
        Ok(())
    } else {
        Err("permission mode is invalid".to_string())
    }
}

fn validate_model(value: &str) -> Result<(), String> {
    if value.is_empty() || value.len() > MAX_MODEL_BYTES || !value.is_ascii() {
        Err("model is invalid".to_string())
    } else {
        Ok(())
    }
}

fn app_cwd() -> PathBuf {
    env::var_os("EMMA_APP_CWD")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn session_index_path() -> PathBuf {
    if let Ok(path) = env::var("EMMA_SESSION_INDEX") {
        return PathBuf::from(path);
    }
    if let Ok(home) = env::var("EMMA_HOME") {
        return PathBuf::from(home).join("emma-sessions.json");
    }
    env::var("HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("."))
        .join(".emma/emma-sessions.json")
}

fn load_session_index(path: &PathBuf) -> HashMap<String, String> {
    let Ok(bytes) = fs::read(path) else {
        return HashMap::new();
    };
    let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
        return HashMap::new();
    };
    let Some(object) = value.as_object() else {
        return HashMap::new();
    };
    object
        .iter()
        .take(MAX_SESSIONS)
        .filter_map(|(thread_id, session_id)| {
            let session_id = session_id.as_str()?;
            validate_id(thread_id, "thread ID").ok()?;
            validate_id(session_id, "session ID").ok()?;
            Some((thread_id.clone(), session_id.to_string()))
        })
        .collect()
}

fn save_session_index(path: &PathBuf, sessions: &HashMap<String, String>) {
    let object = sessions
        .iter()
        .take(MAX_SESSIONS)
        .map(|(thread_id, session_id)| (thread_id.clone(), Value::String(session_id.clone())))
        .collect::<Map<_, _>>();
    let Ok(bytes) = serde_json::to_vec(&Value::Object(object)) else {
        return;
    };
    if let Some(parent) = path.parent() {
        let _ = fs::create_dir_all(parent);
    }
    let temporary = path.with_extension("json.tmp");
    if fs::write(&temporary, bytes).is_ok() {
        let _ = fs::rename(temporary, path);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn request_is_json_rpc_with_stable_numeric_id() {
        let value = request_value(7, "session/prompt", json!({"sessionId":"s1"}));
        assert_eq!(value["jsonrpc"], "2.0");
        assert_eq!(value["id"], 7);
        assert_eq!(value["method"], "session/prompt");
    }

    #[test]
    fn permission_response_preserves_id_and_cancels() {
        let id = WireId::Number(11);
        let value = json!({
            "jsonrpc": "2.0",
            "id": id.value(),
            "result": cancelled_permission_result()
        });
        assert_eq!(value["id"], 11);
        assert_eq!(value["result"]["outcome"]["outcome"], "cancelled");
    }

    #[test]
    fn permission_response_keeps_original_option_ids() {
        let options = vec![
            AcpPermissionOption {
                option_id: "allow_once".to_string(),
                name: "Allow once".to_string(),
                kind: "allow_once".to_string(),
            },
            AcpPermissionOption {
                option_id: "reject_once".to_string(),
                name: "Reject".to_string(),
                kind: "reject_once".to_string(),
            },
        ];
        let value = permission_result(&options, Some("allow_once".to_string()));
        assert_eq!(value["outcome"]["outcome"], "selected");
        assert_eq!(value["outcome"]["optionId"], "allow_once");
        assert_eq!(
            permission_result(&options, Some("unknown".to_string()))["outcome"]["outcome"],
            "cancelled"
        );
    }

    #[test]
    fn permission_options_are_bounded_to_known_sessions() {
        let (_, commands) = async_channel::bounded(1);
        let (events, event_receiver) = async_channel::bounded(4);
        let mut manager = Manager {
            binary: PathBuf::from("emma-cli"),
            cwd: PathBuf::from("."),
            commands,
            events,
            next_id: 1,
            pending: HashMap::new(),
            sessions: HashMap::from([(String::from("thread-1"), String::from("session-1"))]),
            threads_by_session: HashMap::from([(
                String::from("session-1"),
                String::from("thread-1"),
            )]),
            queued: VecDeque::new(),
            active: None,
            process: None,
            session_index: PathBuf::from("emma-sessions.json"),
            pending_permissions: HashMap::new(),
            tool_calls: HashMap::new(),
            stderr_tail: String::new(),
        };
        let request = json!({
            "sessionId": "session-1",
            "toolCall": {"title": "Write file"},
            "options": [{"optionId": "allow_once", "name": "Allow once", "kind": "allow_once"}]
        });
        manager.handle_permission(WireId::String("permission-1".to_string()), Some(&request));
        assert_eq!(manager.pending_permissions.len(), 1);
        match event_receiver.try_recv().unwrap() {
            AcpEvent::PermissionAsked {
                thread_id,
                session_id,
                request_id,
                options,
                ..
            } => {
                assert_eq!(thread_id.as_deref(), Some("thread-1"));
                assert_eq!(session_id.as_deref(), Some("session-1"));
                assert_eq!(request_id, "permission-1");
                assert_eq!(options[0].option_id, "allow_once");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn update_delta_accepts_incremental_message_and_thought_chunks() {
        let message = json!({
            "sessionUpdate": "agent_message_chunk",
            "content": {"type": "text", "text": "hello"}
        });
        let thought = json!({
            "sessionUpdate": "agent_thought_chunk",
            "content": {"type": "text", "text": "thinking"}
        });
        assert_eq!(
            update_delta(Some(&message)),
            Some((false, "hello".to_string()))
        );
        assert_eq!(
            update_delta(Some(&thought)),
            Some((true, "thinking".to_string()))
        );
    }

    #[test]
    fn usage_defaults_missing_fields_without_fabricating_counts() {
        let usage = parse_usage(Some(&json!({"inputTokens": 4, "outputTokens": 9})));
        assert_eq!(usage.input_tokens, 4);
        assert_eq!(usage.output_tokens, 9);
        assert_eq!(usage.cache_write_tokens, None);
        assert_eq!(parse_usage(None), AcpUsage::default());
    }

    #[test]
    fn invalid_wire_ids_fail_closed() {
        assert!(parse_wire_id_value(&Value::Null).is_none());
        assert!(parse_wire_id_value(&Value::String(String::new())).is_none());
        assert!(parse_wire_id_value(&json!(-1)).is_none());
    }

    #[test]
    fn caller_configuration_accepts_native_permission_modes_and_models() {
        for mode in ["plan", "ask", "acceptEdits", "auto", "full"] {
            assert!(validate_mode_id(mode).is_ok());
        }
        assert!(validate_mode_id("code").is_err());
        assert!(validate_model("openrouter/example").is_ok());
        assert!(validate_model("").is_err());
    }

    #[test]
    fn session_mode_stays_ask_while_caller_mode_remains_separate() {
        assert_eq!(session_mode_params("session-1")["modeId"], ACP_MODE_ID);
        let prompt = Prompt {
            thread_id: "thread-1".to_string(),
            text: "text".to_string(),
            permission_mode: "full".to_string(),
            model: None,
        };
        assert_eq!(prompt.permission_mode, "full");
    }

    #[test]
    fn active_session_updates_are_routed_to_the_matching_thread() {
        let (_, commands) = async_channel::bounded(1);
        let (events, event_receiver) = async_channel::bounded(4);
        let mut manager = Manager {
            binary: PathBuf::from("emma-cli"),
            cwd: PathBuf::from("."),
            commands,
            events,
            next_id: 1,
            pending: HashMap::new(),
            sessions: HashMap::from([(String::from("thread-1"), String::from("session-1"))]),
            threads_by_session: HashMap::from([(
                String::from("session-1"),
                String::from("thread-1"),
            )]),
            queued: VecDeque::new(),
            active: Some(ActivePrompt {
                thread_id: String::from("thread-1"),
                permission_mode: String::from("ask"),
                bytes: 0,
            }),
            process: None,
            session_index: PathBuf::from("emma-sessions.json"),
            pending_permissions: HashMap::new(),
            tool_calls: HashMap::new(),
            stderr_tail: String::new(),
        };
        let update = json!({
            "sessionId": "session-1",
            "update": {
                "sessionUpdate": "agent_message_chunk",
                "content": {"type": "text", "text": "hello"}
            }
        });
        manager.handle_update(Some(&update));
        match event_receiver.try_recv().unwrap() {
            AcpEvent::TextDelta { thread_id, text } => {
                assert_eq!(thread_id, "thread-1");
                assert_eq!(text, "hello");
            }
            _ => panic!(),
        }
        assert_eq!(manager.active.as_ref().map(|active| active.bytes), Some(5));
    }

    #[test]
    fn tool_call_updates_merge_lifecycle_fields_and_command_results() {
        let initial = json!({
            "sessionUpdate": "tool_call",
            "toolCallId": "call_1",
            "title": "Run command",
            "kind": "execute",
            "status": "pending",
            "_emma_toolName": "terminal",
            "rawInput": "{\"command\":\"pwd\"}",
            "_emma_filePath": "/tmp/work",
        });
        let call = parse_tool_call(initial.as_object().unwrap(), true, None).unwrap();
        let update = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_1",
            "status": "completed",
            "content": [{
                "type": "content",
                "content": {"type": "text", "text": "done"}
            }],
            "command_result": {"kind": "foreground", "exit_code": 0}
        });
        let merged = parse_tool_call(update.as_object().unwrap(), false, Some(&call)).unwrap();
        assert_eq!(merged.id, "call_1");
        assert_eq!(merged.title, "Run command");
        assert_eq!(merged.kind, "execute");
        assert_eq!(merged.status, "completed");
        assert_eq!(merged.tool_name.as_deref(), Some("terminal"));
        assert_eq!(merged.input, "{\"command\":\"pwd\"}");
        assert_eq!(merged.output, "done");
        assert_eq!(merged.path.as_deref(), Some("/tmp/work"));
        assert_eq!(
            merged.command_result.as_deref(),
            Some("{\"kind\":\"foreground\",\"exit_code\":0}")
        );
    }

    #[test]
    fn structured_diff_is_typed_and_rejects_oversized_lines() {
        let diff = json!({
            "path": "src/main.rs",
            "added": 1,
            "removed": 1,
            "hunks": [
                {"kind": "removed", "line": 4, "text": "old"},
                {"kind": "added", "line": 4, "text": "new"}
            ]
        });
        let parsed = parse_edit_diff(Some(&diff)).unwrap().unwrap();
        assert_eq!(parsed.path, "src/main.rs");
        assert_eq!(parsed.added, 1);
        assert_eq!(parsed.removed, 1);
        assert_eq!(parsed.hunks[0].kind, "removed");
        let oversized = json!({
            "path": "src/main.rs",
            "hunks": [{"kind": "context", "line": 1, "text": "x".repeat(MAX_METADATA_TEXT_BYTES + 1)}]
        });
        assert!(parse_edit_diff(Some(&oversized)).is_err());
    }

    #[test]
    fn session_info_metadata_preserves_usage_context_routing_and_recovery() {
        let update = json!({
            "sessionUpdate": "session_info_update",
            "_meta": {"fx": {
                "turnUsage": {"inputTokens": 12, "outputTokens": 34, "cacheWriteTokens": 2},
                "contextBreakdown": {
                    "systemPromptBytes": 10,
                    "systemToolsBytes": 20,
                    "mcpToolsBytes": 30,
                    "skillsBytes": 40,
                    "memoryBytes": 50
                },
                "routedModel": {"model": "provider/model", "fellBack": true},
                "modelResponseRecovery": {
                    "state": "paused",
                    "kind": "provider",
                    "attempt": 2,
                    "attemptLimit": 3,
                    "delaySeconds": 4,
                    "durable": true,
                    "message": "retrying"
                }
            }}
        });
        let (_, commands) = async_channel::bounded(1);
        let (events, event_receiver) = async_channel::bounded(8);
        let mut manager = test_manager(commands, events, None);
        manager
            .handle_session_info("thread-1", update.as_object().unwrap())
            .unwrap();
        match event_receiver.try_recv().unwrap() {
            AcpEvent::Usage { thread_id, usage } => {
                assert_eq!(thread_id, "thread-1");
                assert_eq!(usage.input_tokens, 12);
            }
            _ => panic!(),
        }
        match event_receiver.try_recv().unwrap() {
            AcpEvent::Context { context, .. } => {
                assert_eq!(context.system_tools_bytes, 20);
                assert_eq!(context.memory_bytes, 50);
            }
            _ => panic!(),
        }
        match event_receiver.try_recv().unwrap() {
            AcpEvent::RoutedModel {
                model, fell_back, ..
            } => {
                assert_eq!(model, "provider/model");
                assert!(fell_back);
            }
            _ => panic!(),
        }
        match event_receiver.try_recv().unwrap() {
            AcpEvent::Recovery { recovery, .. } => {
                assert_eq!(recovery.state, "paused");
                assert_eq!(recovery.attempt, Some(2));
            }
            _ => panic!(),
        }
        match event_receiver.try_recv().unwrap() {
            AcpEvent::ThoughtDelta { text, .. } => {
                assert_eq!(text, "retrying (attempt 2 of 3), retrying in 4s\n")
            }
            _ => panic!(),
        }
    }

    #[test]
    fn child_tag_emits_parent_correlation_before_child_delta() {
        let (_, commands) = async_channel::bounded(1);
        let (events, event_receiver) = async_channel::bounded(8);
        let mut manager = test_manager(
            commands,
            events,
            Some(ActivePrompt {
                thread_id: "thread-1".to_string(),
                permission_mode: "ask".to_string(),
                bytes: 0,
            }),
        );
        let update = json!({
            "sessionId": "session-1",
            "update": {
                "sessionUpdate": "agent_thought_chunk",
                "content": {"type": "text", "text": "child thought"},
                "_meta": {"fx": {"child": {"id": "child-1", "title": "Read docs", "state": "running"}}}
            }
        });
        manager.handle_update(Some(&update));
        match event_receiver.try_recv().unwrap() {
            AcpEvent::Subagent { thread_id, update } => {
                assert_eq!(thread_id, "thread-1");
                assert_eq!(update.id, "child-1");
                assert_eq!(update.parent_id.as_deref(), Some("thread-1"));
            }
            _ => panic!(),
        }
        match event_receiver.try_recv().unwrap() {
            AcpEvent::ThoughtDelta { thread_id, text } => {
                assert_eq!(thread_id, "child-1");
                assert_eq!(text, "child thought");
            }
            _ => panic!(),
        }
    }

    #[test]
    fn unknown_and_malformed_metadata_fail_closed() {
        let invalid = json!({
            "sessionUpdate": "tool_call_update",
            "toolCallId": "call_1",
            "status": "completed",
            "command_result": "x".repeat(MAX_METADATA_TEXT_BYTES + 1)
        });
        assert!(parse_tool_call(invalid.as_object().unwrap(), false, None).is_err());
        let invalid_recovery = json!({"state": "paused", "message": 12});
        assert!(parse_recovery(&invalid_recovery).is_err());
        assert!(
            parse_child_tag(
                json!({"_meta": {"fx": {"child": {"id": "../escape"}}}})
                    .as_object()
                    .unwrap()
            )
            .is_err()
        );
    }

    #[test]
    fn plans_tasks_timeline_completion_and_commands_are_bounded() {
        let plan = json!({
            "sessionUpdate": "plan",
            "id": "ship",
            "title": "Ship",
            "goal": "Release it",
            "updatedAt": "2026-08-31T12:00:00Z",
            "entries": [{
                "id": "build",
                "title": "Build",
                "status": "running",
                "needs": [],
                "brief": "Compile",
                "result": null
            }]
        });
        let parsed_plan = parse_plan(plan.as_object().unwrap()).unwrap();
        assert_eq!(parsed_plan.id, "ship");
        assert_eq!(parsed_plan.steps[0].status, "running");

        let task_list = json!({
            "sessionUpdate": "task_list",
            "id": "release",
            "title": "Release",
            "tasks": [{
                "id": "build",
                "title": "Build",
                "status": "completed",
                "subtasks": [{"id": "tests", "title": "Tests", "status": "in_progress"}]
            }]
        });
        let parsed_tasks = parse_task_list(task_list.as_object().unwrap()).unwrap();
        assert_eq!(parsed_tasks.tasks.len(), 2);
        assert_eq!(parsed_tasks.tasks[1].parent_id.as_deref(), Some("build"));
        assert_eq!(parsed_tasks.tasks[1].depth, 1);

        let timeline = json!({
            "sessionUpdate": "activity",
            "id": "span-1",
            "name": "Compile",
            "kind": "tool",
            "startedAt": 10,
            "endedAt": 20,
            "status": "done",
            "tokens": 4
        });
        let parsed_timeline = parse_timeline_span(timeline.as_object().unwrap()).unwrap();
        assert_eq!(parsed_timeline.started_at, 10);
        assert_eq!(parsed_timeline.ended_at, Some(20));

        let completion = json!({
            "sessionUpdate": "completion",
            "menu": {
                "sigil": "@",
                "query": "doc",
                "active": 1,
                "items": [{"id": "docs", "name": "Docs", "kind": "file", "detail": "Files"}]
            }
        });
        let parsed_completion = parse_completion_menu(completion.as_object().unwrap())
            .unwrap()
            .unwrap();
        assert_eq!(parsed_completion.sigil, "@");
        assert_eq!(parsed_completion.items[0].id, "docs");
        assert_eq!(parsed_completion.active, 1);

        let commands = json!({
            "sessionUpdate": "available_commands_update",
            "availableCommands": ["help", {"id": "stop", "description": "Stop"}]
        });
        let parsed_commands = parse_available_commands(commands.as_object().unwrap()).unwrap();
        assert_eq!(parsed_commands.len(), 2);
        assert_eq!(parsed_commands[1].name, "stop");
    }

    fn test_manager(
        commands: async_channel::Receiver<AcpCommand>,
        events: async_channel::Sender<AcpEvent>,
        active: Option<ActivePrompt>,
    ) -> Manager {
        Manager {
            binary: PathBuf::from("emma-cli"),
            cwd: PathBuf::from("."),
            commands,
            events,
            next_id: 1,
            pending: HashMap::new(),
            sessions: HashMap::from([("thread-1".to_string(), "session-1".to_string())]),
            threads_by_session: HashMap::from([("session-1".to_string(), "thread-1".to_string())]),
            queued: VecDeque::new(),
            active,
            process: None,
            session_index: PathBuf::from("emma-sessions.json"),
            pending_permissions: HashMap::new(),
            tool_calls: HashMap::new(),
            stderr_tail: String::new(),
        }
    }
}
