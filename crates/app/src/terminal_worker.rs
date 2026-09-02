use std::{
    collections::{HashMap, VecDeque},
    env,
    io::{self, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender, SyncSender, TryRecvError},
    thread::{self, JoinHandle},
    time::{Duration, Instant},
};

use crate::terminal_surface::{
    MAX_TERMINAL_EVENT_BYTES, MAX_TERMINAL_SCROLLBACK, MAX_TERMINAL_TITLE_BYTES, PTY_HELPER_NAME,
    PtySpawn, TerminalCommand, TerminalError, TerminalEvent, TerminalWorkerPort,
};

const SIGKILL_AFTER: Duration = Duration::from_secs(2);
const SESSION_MESSAGES: usize = 16;
const MAX_PENDING_EVENTS: usize = 128;
const MAX_PENDING_EVENT_BYTES: usize = MAX_TERMINAL_SCROLLBACK;
const SESSION_TICK: Duration = Duration::from_millis(20);
const MAX_COMMANDS_PER_TICK: usize = 32;
#[cfg(unix)]
const RESIZE_FD: i32 = 3;

#[cfg(unix)]
use std::fs::File;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalWorkerConfig {
    pub helper: PathBuf,
}

impl TerminalWorkerConfig {
    pub fn new(helper: impl Into<PathBuf>) -> Self {
        Self {
            helper: helper.into(),
        }
    }

    pub fn default_helper() -> Self {
        Self::new(default_helper_path())
    }
}

pub fn default_helper_path() -> PathBuf {
    if let Some(path) = env::var_os("EMMA_PTY_PATH") {
        return PathBuf::from(path);
    }
    let mut candidates = Vec::new();
    if let Ok(executable) = env::current_exe()
        && let Some(parent) = executable.parent()
    {
        candidates.push(parent.join(PTY_HELPER_NAME));
        if let Some(contents) = parent.parent() {
            candidates.push(contents.join("Resources").join(PTY_HELPER_NAME));
        }
    }
    candidates.push(PathBuf::from("desktop/dist-native").join(PTY_HELPER_NAME));
    candidates.push(PathBuf::from("desktop/dist-native").join(format!("{PTY_HELPER_NAME}.exe")));
    candidates
        .into_iter()
        .find(|candidate| candidate.is_file())
        .unwrap_or_else(|| PathBuf::from(PTY_HELPER_NAME))
}

pub struct TerminalWorker {
    port: TerminalWorkerPort,
    config: TerminalWorkerConfig,
}

impl TerminalWorker {
    pub fn new(port: TerminalWorkerPort, helper: impl Into<PathBuf>) -> Self {
        Self {
            port,
            config: TerminalWorkerConfig::new(helper),
        }
    }

    pub fn with_default_helper(port: TerminalWorkerPort) -> Self {
        Self {
            port,
            config: TerminalWorkerConfig::default_helper(),
        }
    }

    pub fn start(
        port: TerminalWorkerPort,
        helper: impl Into<PathBuf> + Send + 'static,
    ) -> JoinHandle<Result<(), TerminalError>> {
        thread::spawn(move || Self::new(port, helper).run())
    }

    pub fn start_with_default_helper(
        port: TerminalWorkerPort,
    ) -> JoinHandle<Result<(), TerminalError>> {
        thread::spawn(move || Self::with_default_helper(port).run())
    }

    pub fn run(self) -> Result<(), TerminalError> {
        let (message_sender, message_receiver) = mpsc::channel();
        let mut sessions = HashMap::new();
        let mut pending = PendingEvents::default();
        let mut disconnected = false;
        loop {
            if !pending.flush(&self.port) {
                disconnected = true;
                break;
            }
            let mut progressed = false;
            for _ in 0..MAX_COMMANDS_PER_TICK {
                let Some(command) = self.port.try_recv() else {
                    break;
                };
                progressed = true;
                handle_command(
                    &mut sessions,
                    &self.config,
                    &message_sender,
                    &mut pending,
                    command,
                );
            }
            loop {
                match message_receiver.try_recv() {
                    Ok(message) => {
                        progressed = true;
                        handle_message(&mut sessions, &mut pending, message);
                    }
                    Err(TryRecvError::Empty) => break,
                    Err(TryRecvError::Disconnected) => {
                        disconnected = true;
                        break;
                    }
                }
            }
            if disconnected {
                break;
            }
            if !progressed {
                if sessions.values().all(|session| !session.running) && pending.is_empty() {
                    match self.port.recv() {
                        Ok(command) => handle_command(
                            &mut sessions,
                            &self.config,
                            &message_sender,
                            &mut pending,
                            command,
                        ),
                        Err(_) => break,
                    }
                } else {
                    match message_receiver.recv_timeout(SESSION_TICK) {
                        Ok(message) => handle_message(&mut sessions, &mut pending, message),
                        Err(RecvTimeoutError::Timeout) => {}
                        Err(RecvTimeoutError::Disconnected) => break,
                    }
                }
            }
        }
        for (_, session) in sessions.drain() {
            session.close();
        }
        if disconnected {
            return Ok(());
        }
        Ok(())
    }
}

struct SessionRecord {
    commands: Sender<SessionCommand>,
    join: Option<JoinHandle<()>>,
    replay: ReplayState,
    running: bool,
}

impl SessionRecord {
    fn new(spawn: PtySpawn, helper: PathBuf, messages: Sender<WorkerMessage>) -> Self {
        let (commands, command_receiver) = mpsc::channel();
        let join = thread::spawn(move || run_session(spawn, helper, command_receiver, messages));
        Self {
            commands,
            join: Some(join),
            replay: ReplayState::default(),
            running: true,
        }
    }

    fn close(mut self) {
        let _ = self.commands.send(SessionCommand::Close);
        if let Some(join) = self.join.take() {
            let _ = join.join();
        }
    }
}

impl Drop for SessionRecord {
    fn drop(&mut self) {
        let _ = self.commands.send(SessionCommand::Close);
    }
}

enum SessionCommand {
    Write(Vec<u8>),
    Resize(u16, u16),
    Close,
}

enum WorkerMessage {
    Spawned { id: String },
    Output { id: String, data: Vec<u8> },
    Exited { id: String, code: Option<i32> },
    Error { id: String, message: String },
}

fn handle_command(
    sessions: &mut HashMap<String, SessionRecord>,
    config: &TerminalWorkerConfig,
    messages: &Sender<WorkerMessage>,
    pending: &mut PendingEvents,
    command: TerminalCommand,
) {
    match command {
        TerminalCommand::Spawn(spawn) => {
            if sessions.contains_key(&spawn.id) {
                pending.enqueue(TerminalEvent::Error {
                    id: spawn.id,
                    message: "terminal session already exists".to_owned(),
                });
            } else {
                let id = spawn.id.clone();
                sessions.insert(
                    id,
                    SessionRecord::new(spawn, config.helper.clone(), messages.clone()),
                );
            }
        }
        TerminalCommand::Write { id, data } => {
            if let Some(session) = sessions.get(&id) {
                let _ = session.commands.send(SessionCommand::Write(data));
            }
        }
        TerminalCommand::Resize { id, columns, rows } => {
            if let Some(session) = sessions.get(&id) {
                let _ = session.commands.send(SessionCommand::Resize(columns, rows));
            }
        }
        TerminalCommand::Replay { id, after } => {
            if let Some(session) = sessions.get(&id) {
                session.replay.enqueue_replay(&id, after, pending);
            }
        }
        TerminalCommand::Close { id } => {
            if let Some(session) = sessions.remove(&id) {
                session.close();
            }
        }
    }
}

fn handle_message(
    sessions: &mut HashMap<String, SessionRecord>,
    pending: &mut PendingEvents,
    message: WorkerMessage,
) {
    match message {
        WorkerMessage::Spawned { id } => {
            if sessions.contains_key(&id) {
                pending.enqueue(TerminalEvent::Spawned { id });
            }
        }
        WorkerMessage::Output { id, data } => {
            if let Some(session) = sessions.get_mut(&id) {
                let at = session.replay.append(&data);
                pending.enqueue(TerminalEvent::Output { id, data, at });
            }
        }
        WorkerMessage::Exited { id, code } => {
            if let Some(session) = sessions.get_mut(&id) {
                session.running = false;
                let marker = match code.filter(|code| *code != 0) {
                    Some(code) => format!("\r\n[session ended — exit {code}]\r\n"),
                    None => "\r\n[session ended]\r\n".to_owned(),
                };
                session.replay.append(marker.as_bytes());
                pending.enqueue(TerminalEvent::Exited { id, code });
            }
        }
        WorkerMessage::Error { id, message } => {
            if let Some(session) = sessions.get_mut(&id) {
                session.running = false;
                pending.enqueue(TerminalEvent::Error {
                    id,
                    message: bounded_message(&message),
                });
            }
        }
    }
}

#[derive(Default)]
struct PendingEvents {
    events: VecDeque<TerminalEvent>,
    bytes: usize,
}

impl PendingEvents {
    fn is_empty(&self) -> bool {
        self.events.is_empty()
    }

    fn enqueue(&mut self, event: TerminalEvent) {
        let bytes = event_bytes(&event);
        while self.events.len() >= MAX_PENDING_EVENTS
            || self.bytes.saturating_add(bytes) > MAX_PENDING_EVENT_BYTES
        {
            if let Some(index) = self.events.iter().position(is_output_event) {
                if let Some(removed) = self.events.remove(index) {
                    self.bytes = self.bytes.saturating_sub(event_bytes(&removed));
                }
            } else {
                return;
            }
        }
        self.bytes = self.bytes.saturating_add(bytes);
        self.events.push_back(event);
    }

    fn flush(&mut self, port: &TerminalWorkerPort) -> bool {
        loop {
            let Some(event) = self.events.front().cloned() else {
                return true;
            };
            match port.send_event(event) {
                Ok(()) => {
                    if let Some(event) = self.events.pop_front() {
                        self.bytes = self.bytes.saturating_sub(event_bytes(&event));
                    }
                }
                Err(TerminalError::QueueFull) => return true,
                Err(TerminalError::TransportClosed) => return false,
                Err(_) => {
                    if let Some(event) = self.events.pop_front() {
                        self.bytes = self.bytes.saturating_sub(event_bytes(&event));
                    }
                }
            }
        }
    }
}

fn event_bytes(event: &TerminalEvent) -> usize {
    match event {
        TerminalEvent::Output { data, .. } | TerminalEvent::Replay { data, .. } => data.len(),
        _ => 0,
    }
}

fn is_output_event(event: &TerminalEvent) -> bool {
    matches!(
        event,
        TerminalEvent::Output { .. } | TerminalEvent::Replay { .. }
    )
}

fn run_session(
    spawn: PtySpawn,
    helper: PathBuf,
    commands: Receiver<SessionCommand>,
    messages: Sender<WorkerMessage>,
) {
    let id = spawn.id.clone();
    let process = match spawn_process(&spawn, &helper) {
        Ok(process) => process,
        Err(error) => {
            let _ = messages.send(WorkerMessage::Error {
                id,
                message: error.to_string(),
            });
            return;
        }
    };
    if messages
        .send(WorkerMessage::Spawned { id: id.clone() })
        .is_err()
    {
        let mut child = process.child;
        stop_child(&mut child);
        let _ = child.wait();
        return;
    }
    let (output_sender, output_receiver) = mpsc::sync_channel(SESSION_MESSAGES);
    let stdout_join = spawn_reader(process.stdout, output_sender.clone());
    let stderr_join = spawn_reader(process.stderr, output_sender.clone());
    drop(output_sender);
    let mut child = process.child;
    let mut stdin = process.stdin;
    let mut resize = process.resize;
    let mut reader_done = 0;
    let mut process_done = false;
    let mut exit_code = None;
    let mut stop_started = None;
    let mut force_sent = false;
    loop {
        let mut progressed = false;
        while let Ok(command) = commands.try_recv() {
            progressed = true;
            match command {
                SessionCommand::Write(data) if !process_done && stop_started.is_none() => {
                    let _ = stdin.write_all(&data);
                }
                SessionCommand::Resize(columns, rows)
                    if !process_done && stop_started.is_none() =>
                {
                    write_resize(&mut resize, columns, rows);
                }
                SessionCommand::Close => {
                    if !process_done && stop_started.is_none() {
                        stop_child(&mut child);
                        stop_started = Some(Instant::now());
                    }
                }
                SessionCommand::Write(_) | SessionCommand::Resize(_, _) => {}
            }
        }
        while let Ok(message) = output_receiver.try_recv() {
            progressed = true;
            match message {
                SessionMessage::Output(data) => {
                    if messages
                        .send(WorkerMessage::Output {
                            id: id.clone(),
                            data,
                        })
                        .is_err()
                    {
                        stop_child(&mut child);
                        process_done = true;
                        break;
                    }
                }
                SessionMessage::ReaderDone => reader_done += 1,
            }
        }
        if !process_done {
            match child.try_wait() {
                Ok(Some(status)) => {
                    process_done = true;
                    exit_code = status.code();
                    progressed = true;
                }
                Ok(None) => {}
                Err(error) => {
                    let _ = messages.send(WorkerMessage::Error {
                        id: id.clone(),
                        message: error.to_string(),
                    });
                    process_done = true;
                    progressed = true;
                }
            }
        }
        if !process_done
            && let Some(started) = stop_started
            && !force_sent
            && started.elapsed() >= SIGKILL_AFTER
        {
            force_child(&mut child);
            force_sent = true;
            progressed = true;
        }
        if process_done && reader_done >= 2 {
            let _ = messages.send(WorkerMessage::Exited {
                id: id.clone(),
                code: exit_code,
            });
            break;
        }
        if !progressed {
            match output_receiver.recv_timeout(SESSION_TICK) {
                Ok(SessionMessage::Output(data)) => {
                    let _ = messages.send(WorkerMessage::Output {
                        id: id.clone(),
                        data,
                    });
                }
                Ok(SessionMessage::ReaderDone) => reader_done += 1,
                Err(RecvTimeoutError::Timeout) => {}
                Err(RecvTimeoutError::Disconnected) => break,
            }
        }
    }
    drop(stdin);
    drop(resize);
    let _ = stdout_join.join();
    let _ = stderr_join.join();
}

enum SessionMessage {
    Output(Vec<u8>),
    ReaderDone,
}

#[derive(Default)]
struct ReplayState {
    bytes: VecDeque<u8>,
    written: u64,
}

impl ReplayState {
    fn append(&mut self, data: &[u8]) -> u64 {
        for byte in data {
            self.bytes.push_back(*byte);
        }
        while self.bytes.len() > MAX_TERMINAL_SCROLLBACK {
            self.bytes.pop_front();
        }
        self.written = self.written.saturating_add(data.len() as u64);
        self.written
    }

    fn enqueue_replay(&self, id: &str, after: u64, pending: &mut PendingEvents) {
        let end = self.written;
        let retained_start = end.saturating_sub(self.bytes.len() as u64);
        let start = after.max(retained_start).min(end);
        let skip = start.saturating_sub(retained_start) as usize;
        let data = self.bytes.iter().skip(skip).copied().collect::<Vec<_>>();
        if data.is_empty() {
            pending.enqueue(TerminalEvent::Replay {
                id: id.to_owned(),
                data,
                at: end,
            });
            return;
        }
        let mut at = start;
        for chunk in data.chunks(MAX_TERMINAL_EVENT_BYTES) {
            at = at.saturating_add(chunk.len() as u64);
            pending.enqueue(TerminalEvent::Replay {
                id: id.to_owned(),
                data: chunk.to_vec(),
                at,
            });
        }
    }
}

fn spawn_reader<R: Read + Send + 'static>(
    reader: R,
    sender: SyncSender<SessionMessage>,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut reader = reader;
        let mut buffer = vec![0; MAX_TERMINAL_EVENT_BYTES];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) => break,
                Ok(length) => {
                    if sender
                        .send(SessionMessage::Output(buffer[..length].to_vec()))
                        .is_err()
                    {
                        return;
                    }
                }
                Err(error) if error.kind() == io::ErrorKind::Interrupted => {}
                Err(_) => break,
            }
        }
        let _ = sender.send(SessionMessage::ReaderDone);
    })
}

struct SpawnedProcess {
    child: Child,
    stdin: ChildStdin,
    stdout: ChildStdout,
    stderr: ChildStderr,
    resize: Option<ResizeWriter>,
}

#[cfg(unix)]
type ResizeWriter = File;

#[cfg(not(unix))]
type ResizeWriter = ();

fn spawn_process(spawn: &PtySpawn, helper: &Path) -> io::Result<SpawnedProcess> {
    let mut command = Command::new(helper);
    command
        .args(spawn.helper_arguments())
        .current_dir(&spawn.cwd)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .envs(env::vars_os());
    for (name, value) in &spawn.environment {
        command.env(name, value);
    }
    command
        .env("TERM", "xterm-256color")
        .env("COLORTERM", "truecolor");
    #[cfg(unix)]
    let (resize_read, resize_write) = create_resize_pipe()?;
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        use std::os::unix::process::CommandExt;
        let read_fd = resize_read.as_raw_fd();
        unsafe {
            command.pre_exec(move || {
                if read_fd != RESIZE_FD {
                    if unix::dup2(read_fd, RESIZE_FD) == -1 {
                        return Err(io::Error::last_os_error());
                    }
                    let _ = unix::close(read_fd);
                }
                Ok(())
            });
        }
    }
    #[cfg(not(unix))]
    let resize_write = None;
    let mut child = command.spawn()?;
    #[cfg(unix)]
    drop(resize_read);
    let Some(stdin) = child.stdin.take() else {
        stop_child(&mut child);
        let _ = child.wait();
        return Err(io::Error::other("terminal stdin was not piped"));
    };
    let Some(stdout) = child.stdout.take() else {
        stop_child(&mut child);
        let _ = child.wait();
        return Err(io::Error::other("terminal stdout was not piped"));
    };
    let Some(stderr) = child.stderr.take() else {
        stop_child(&mut child);
        let _ = child.wait();
        return Err(io::Error::other("terminal stderr was not piped"));
    };
    #[cfg(unix)]
    let resize = Some(resize_write);
    #[cfg(not(unix))]
    let resize = resize_write;
    Ok(SpawnedProcess {
        child,
        stdin,
        stdout,
        stderr,
        resize,
    })
}

fn write_resize(resize: &mut Option<ResizeWriter>, columns: u16, rows: u16) {
    let Ok(line) = PtySpawn::resize_line(columns, rows) else {
        return;
    };
    #[cfg(unix)]
    if let Some(resize) = resize.as_mut() {
        let _ = resize.write_all(line.as_bytes());
    }
    #[cfg(not(unix))]
    let _ = (resize, line);
}

fn bounded_message(message: &str) -> String {
    message
        .char_indices()
        .take_while(|(index, character)| {
            index.saturating_add(character.len_utf8()) <= MAX_TERMINAL_TITLE_BYTES
        })
        .map(|(_, character)| character)
        .collect()
}

fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let result = unsafe { unix::kill(child.id() as i32, unix::SIGHUP) };
        if result == -1 {
            let _ = child.kill();
        }
    }
    #[cfg(windows)]
    terminate_process_tree(child.id(), false);
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
    }
}

fn force_child(child: &mut Child) {
    #[cfg(unix)]
    {
        let result = unsafe { unix::kill(child.id() as i32, unix::SIGKILL) };
        if result == -1 {
            let _ = child.kill();
        }
    }
    #[cfg(windows)]
    terminate_process_tree(child.id(), true);
    #[cfg(not(any(unix, windows)))]
    {
        let _ = child.kill();
    }
}

#[cfg(windows)]
fn terminate_process_tree(pid: u32, force: bool) {
    let executable = env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\Windows"))
        .join("System32")
        .join("taskkill.exe");
    let mut command = Command::new(executable);
    command.args(["/pid", &pid.to_string(), "/t"]);
    if force {
        command.arg("/f");
    }
    let _ = command.status();
}

#[cfg(unix)]
fn create_resize_pipe() -> io::Result<(File, File)> {
    use std::os::fd::FromRawFd;
    let mut fds = [-1; 2];
    if unsafe { unix::pipe(fds.as_mut_ptr()) } == -1 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { (File::from_raw_fd(fds[0]), File::from_raw_fd(fds[1])) })
}

#[cfg(unix)]
mod unix {
    pub const SIGHUP: i32 = 1;
    pub const SIGKILL: i32 = 9;

    unsafe extern "C" {
        pub fn close(fd: i32) -> i32;
        pub fn dup2(old_fd: i32, new_fd: i32) -> i32;
        pub fn kill(pid: i32, signal: i32) -> i32;
        pub fn pipe(fds: *mut i32) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bounded_message_stays_within_the_terminal_error_contract() {
        let message = format!("a{}é", "b".repeat(MAX_TERMINAL_TITLE_BYTES));
        let bounded = bounded_message(&message);
        assert!(bounded.len() <= MAX_TERMINAL_TITLE_BYTES);
        assert!(message.starts_with(&bounded));
    }

    #[test]
    fn replay_offsets_and_retention_are_bounded() {
        let mut state = ReplayState::default();
        let data = vec![b'x'; MAX_TERMINAL_SCROLLBACK + 32];
        assert_eq!(state.append(&data), (MAX_TERMINAL_SCROLLBACK + 32) as u64);
        assert_eq!(state.bytes.len(), MAX_TERMINAL_SCROLLBACK);
        let mut pending = PendingEvents::default();
        state.enqueue_replay("terminal-1", 0, &mut pending);
        assert!(pending.events.iter().all(|event| match event {
            TerminalEvent::Output { data, .. } | TerminalEvent::Replay { data, .. } => {
                data.len() <= MAX_TERMINAL_EVENT_BYTES
            }
            _ => true,
        }));
        assert!(pending.bytes <= MAX_PENDING_EVENT_BYTES);
    }

    #[test]
    fn pending_events_preserve_control_events_when_output_is_bounded() {
        let mut pending = PendingEvents::default();
        for index in 0..MAX_PENDING_EVENTS {
            pending.enqueue(TerminalEvent::Output {
                id: "terminal-1".to_owned(),
                data: vec![index as u8; MAX_TERMINAL_EVENT_BYTES],
                at: index as u64 + 1,
            });
        }
        pending.enqueue(TerminalEvent::Spawned {
            id: "terminal-1".to_owned(),
        });
        assert!(pending.events.iter().any(|event| matches!(
            event,
            TerminalEvent::Spawned { id } if id == "terminal-1"
        )));
        assert!(pending.bytes <= MAX_PENDING_EVENT_BYTES);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_helper_runs_a_shell_and_emits_replayable_output() {
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../desktop/dist-native")
            .join(PTY_HELPER_NAME);
        if !helper.is_file() {
            return;
        }
        let (transport, port) =
            crate::terminal_surface::ChannelTerminalTransport::channel(64).unwrap();
        let worker = TerminalWorker::new(port, helper);
        let join = thread::spawn(move || worker.run());
        let mut controller =
            crate::terminal_surface::TerminalController::new(Some(transport.clone()));
        let mut request = crate::terminal_surface::TerminalOpen::new("thread-1", "/tmp");
        request.id = Some("terminal-1".to_owned());
        request.argv = Some(vec![
            "/bin/sh".to_owned(),
            "-c".to_owned(),
            "printf 'worker-output'".to_owned(),
        ]);
        controller.open(request).unwrap();
        for _ in 0..100 {
            controller.poll_events();
            if matches!(
                controller.list(None).first().map(|tab| tab.lifecycle),
                Some(crate::terminal_surface::TerminalLifecycle::Exited(_))
            ) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        controller.poll_events();
        assert!(
            controller
                .screen("terminal-1")
                .unwrap()
                .text()
                .contains("worker-output")
        );
        assert!(
            controller
                .replay("terminal-1")
                .unwrap()
                .data
                .windows(13)
                .any(|chunk| chunk == b"worker-output")
        );
        assert_eq!(
            controller
                .screen("terminal-1")
                .unwrap()
                .text()
                .matches("[session ended]")
                .count(),
            1
        );
        drop(controller);
        drop(transport);
        assert!(join.join().unwrap().is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn real_helper_applies_fd3_resize_lines_to_the_pty() {
        let helper = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../desktop/dist-native")
            .join(PTY_HELPER_NAME);
        if !helper.is_file() {
            return;
        }
        let (transport, port) =
            crate::terminal_surface::ChannelTerminalTransport::channel(64).unwrap();
        let worker = TerminalWorker::new(port, helper);
        let join = thread::spawn(move || worker.run());
        let mut controller =
            crate::terminal_surface::TerminalController::new(Some(transport.clone()));
        let mut request = crate::terminal_surface::TerminalOpen::new("thread-1", "/tmp");
        request.id = Some("terminal-1".to_owned());
        request.argv = Some(vec![
            "/bin/sh".to_owned(),
            "-c".to_owned(),
            "sleep .2; stty size".to_owned(),
        ]);
        controller.open(request).unwrap();
        thread::sleep(Duration::from_millis(30));
        controller.resize("terminal-1", 100, 30).unwrap();
        for _ in 0..100 {
            controller.poll_events();
            if matches!(
                controller.list(None).first().map(|tab| tab.lifecycle),
                Some(crate::terminal_surface::TerminalLifecycle::Exited(_))
            ) {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        controller.poll_events();
        assert!(
            controller
                .screen("terminal-1")
                .unwrap()
                .text()
                .contains("30 100")
        );
        drop(controller);
        drop(transport);
        assert!(join.join().unwrap().is_ok());
    }
}
