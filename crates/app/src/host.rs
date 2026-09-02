use std::{
    collections::HashMap,
    env,
    io::{self, BufRead, BufReader, Write},
    path::PathBuf,
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};

use serde_json::{Value, json};

const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_RESPONSE_BYTES: usize = 256 * 1024 * 1024;
const MAX_RESPONSE_CHUNK_BYTES: usize = 64 * 1024;
const MAX_RESPONSE_LINE_BYTES: usize = MAX_RESPONSE_CHUNK_BYTES * 4;
const COMMAND_QUEUE_CAPACITY: usize = 64;
const EVENT_QUEUE_CAPACITY: usize = 256;

#[derive(Clone)]
pub(crate) struct HostClient {
    commands: async_channel::Sender<HostCommand>,
    events: async_channel::Receiver<HostEvent>,
    next_id: Arc<AtomicU64>,
}

enum HostCommand {
    Request {
        id: String,
        method: String,
        params: Value,
    },
}

#[derive(Debug)]
pub(crate) enum HostEvent {
    Response {
        id: String,
        result: Result<Value, String>,
    },
    Error(String),
    DueJob(Value),
}

impl HostClient {
    pub(crate) fn new() -> Self {
        let (commands, command_receiver) = async_channel::bounded(COMMAND_QUEUE_CAPACITY);
        let (event_sender, events) = async_channel::bounded(EVENT_QUEUE_CAPACITY);
        let binary = host_binary();
        let _ = thread::Builder::new()
            .name("emma-host-client".to_string())
            .spawn(move || host_worker(binary, command_receiver, event_sender));

        Self {
            commands,
            events,
            next_id: Arc::new(AtomicU64::new(1)),
        }
    }

    pub(crate) fn events(&self) -> async_channel::Receiver<HostEvent> {
        self.events.clone()
    }

    pub(crate) fn request(&self, method: &str, params: Value) -> Result<String, String> {
        if !allowed_method(method) {
            return Err("method is not allowed".to_string());
        }
        if !params.is_null() && !params.is_object() {
            return Err("request params must be an object or null".to_string());
        }
        let id = format!("native-{}", self.next_id.fetch_add(1, Ordering::Relaxed));
        let request = json!({"id": id, "method": method, "params": params});
        let encoded = serde_json::to_vec(&request)
            .map_err(|error| format!("could not encode request: {error}"))?;
        if encoded.len().saturating_add(1) > MAX_REQUEST_BYTES {
            return Err("request is too large".to_string());
        }
        self.commands
            .try_send(HostCommand::Request {
                id: id.clone(),
                method: method.to_string(),
                params: request["params"].clone(),
            })
            .map_err(|error| format!("host worker unavailable: {error}"))?;
        Ok(id)
    }
}

fn allowed_method(method: &str) -> bool {
    matches!(
        method,
        "snapshot"
            | "threadSummaries"
            | "thread"
            | "createThread"
            | "setThreadArchived"
            | "renameThread"
            | "recordTurn"
            | "setGoal"
            | "updateGoal"
            | "clearGoal"
            | "recordTrace"
            | "readTrace"
            | "saveScheduledJob"
            | "deleteScheduledJob"
            | "runScheduledJob"
            | "finishScheduledJob"
            | "fireScheduledEvent"
            | "setScheduledJobEnabled"
            | "saveResearchJob"
            | "deleteResearchJob"
            | "setResearchJobStatus"
            | "setResearchJobThread"
            | "recordResearchIteration"
    )
}

fn host_binary() -> PathBuf {
    if let Ok(path) = env::var("EMMA_HOST_BIN") {
        return PathBuf::from(path);
    }

    let manifest_target =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../target/debug/emma-host");
    let current_target = PathBuf::from("target/debug/emma-host");
    if manifest_target.exists() {
        manifest_target
    } else {
        current_target
    }
}

fn host_worker(
    binary: PathBuf,
    commands: async_channel::Receiver<HostCommand>,
    events: async_channel::Sender<HostEvent>,
) {
    let child = Command::new(&binary)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let Ok(mut child) = child else {
        let _ = events.send_blocking(HostEvent::Error(format!(
            "could not start emma-host at {}",
            binary.display()
        )));
        return;
    };

    let Some(mut stdin) = child.stdin.take() else {
        let _ = events.send_blocking(HostEvent::Error(
            "emma-host did not provide stdin".to_string(),
        ));
        let _ = child.kill();
        return;
    };
    let Some(stdout) = child.stdout.take() else {
        let _ = events.send_blocking(HostEvent::Error(
            "emma-host did not provide stdout".to_string(),
        ));
        let _ = child.kill();
        return;
    };
    if let Some(stderr) = child.stderr.take() {
        let _ = thread::Builder::new()
            .name("emma-host-stderr".to_string())
            .spawn(move || drain_stderr(stderr));
    }

    let reader_events = events.clone();
    let reader = thread::Builder::new()
        .name("emma-host-reader".to_string())
        .spawn(move || read_stdout(stdout, reader_events));

    while let Ok(command) = commands.recv_blocking() {
        match command {
            HostCommand::Request { id, method, params } => {
                let request = json!({"id": id, "method": method, "params": params});
                let Ok(mut encoded) = serde_json::to_vec(&request) else {
                    let _ = events.send_blocking(HostEvent::Error(
                        "could not encode host request".to_string(),
                    ));
                    break;
                };
                encoded.push(b'\n');
                if stdin
                    .write_all(&encoded)
                    .and_then(|_| stdin.flush())
                    .is_err()
                {
                    let _ = events.send_blocking(HostEvent::Error(
                        "could not write to emma-host".to_string(),
                    ));
                    break;
                }
            }
        }
    }

    let _ = child.kill();
    let _ = child.wait();
    if let Ok(reader) = reader {
        let _ = reader.join();
    }
}

fn drain_stderr(stderr: impl std::io::Read) {
    let mut reader = BufReader::new(stderr);
    let mut line = String::new();
    while reader.read_line(&mut line).is_ok() {
        if line.is_empty() {
            break;
        }
        line.clear();
    }
}

fn read_stdout(stdout: impl std::io::Read, events: async_channel::Sender<HostEvent>) {
    let mut chunks = HashMap::new();
    let mut reader = BufReader::new(stdout);
    let mut line = Vec::new();
    loop {
        let has_line = match read_bounded_line(&mut reader, &mut line) {
            Ok(Some(_)) => true,
            Ok(None) => false,
            Err(error) => {
                let _ = events.send_blocking(HostEvent::Error(format!(
                    "could not read emma-host output: {error}"
                )));
                return;
            }
        };
        if !has_line {
            break;
        }
        while line.last().is_some_and(u8::is_ascii_whitespace) {
            line.pop();
        }
        let line = match std::str::from_utf8(&line) {
            Ok(line) => line,
            Err(error) => {
                let _ = events.send_blocking(HostEvent::Error(format!(
                    "could not decode emma-host output: {error}"
                )));
                return;
            }
        };
        match parse_line(line, &mut chunks) {
            Ok(Some(event)) => {
                if events.send_blocking(event).is_err() {
                    return;
                }
            }
            Ok(None) => {}
            Err(error) => {
                if events.send_blocking(HostEvent::Error(error)).is_err() {
                    return;
                }
            }
        }
    }
    let _ = events.send_blocking(HostEvent::Error("emma-host exited".to_string()));
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
        if line.len().saturating_add(length) > MAX_RESPONSE_LINE_BYTES.saturating_add(1) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "host response line is too large",
            ));
        }
        line.extend_from_slice(&buffer[..length]);
        reader.consume(length);
        if newline.is_some() {
            return Ok(Some(line.len()));
        }
    }
}

struct ChunkState {
    next_sequence: u64,
    bytes: usize,
    value: String,
}

fn parse_line(
    line: &str,
    chunks: &mut HashMap<String, ChunkState>,
) -> Result<Option<HostEvent>, String> {
    if line.len() > MAX_RESPONSE_LINE_BYTES {
        return Err("host response line is too large".to_string());
    }
    let value: Value = serde_json::from_str(line)
        .map_err(|error| format!("could not parse emma-host output: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "host response must be an object".to_string())?;
    if let Some(job) = object.get("dueJob") {
        return Ok(Some(HostEvent::DueJob(job.clone())));
    }
    if object.contains_key("chunk") {
        return parse_chunk(object, chunks);
    }
    parse_response(object).map(Some)
}

fn parse_chunk(
    object: &serde_json::Map<String, Value>,
    chunks: &mut HashMap<String, ChunkState>,
) -> Result<Option<HostEvent>, String> {
    let id = response_id(object)?;
    let chunk = object
        .get("chunk")
        .and_then(Value::as_str)
        .ok_or_else(|| "host response chunk is invalid".to_string())?;
    let sequence = object
        .get("sequence")
        .and_then(Value::as_u64)
        .ok_or_else(|| "host response sequence is invalid".to_string())?;
    let end = object
        .get("end")
        .and_then(Value::as_bool)
        .ok_or_else(|| "host response end marker is invalid".to_string())?;
    let state = chunks.entry(id.clone()).or_insert_with(|| ChunkState {
        next_sequence: 0,
        bytes: 0,
        value: String::new(),
    });
    if state.next_sequence != sequence {
        chunks.remove(&id);
        return Err("host response chunks arrived out of order".to_string());
    }
    state.bytes = state.bytes.saturating_add(chunk.len());
    if state.bytes > MAX_RESPONSE_BYTES {
        chunks.remove(&id);
        return Err("host response is too large".to_string());
    }
    state.value.push_str(chunk);
    state.next_sequence = state.next_sequence.saturating_add(1);
    if !end {
        return Ok(None);
    }
    let state = chunks.remove(&id).expect("chunk state exists");
    let value: Value = serde_json::from_str(&state.value)
        .map_err(|error| format!("could not parse assembled host response: {error}"))?;
    let object = value
        .as_object()
        .ok_or_else(|| "assembled host response must be an object".to_string())?;
    parse_response(object).map(Some)
}

fn response_id(object: &serde_json::Map<String, Value>) -> Result<String, String> {
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "host response id is invalid".to_string())?;
    if id.is_empty() || id.len() > 128 || !id.bytes().all(|byte| byte.is_ascii_graphic()) {
        return Err("host response id is invalid".to_string());
    }
    Ok(id.to_string())
}

fn parse_response(object: &serde_json::Map<String, Value>) -> Result<HostEvent, String> {
    let id = response_id(object)?;
    match object.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(HostEvent::Response {
            id,
            result: Ok(object.get("result").cloned().unwrap_or(Value::Null)),
        }),
        Some(false) => {
            let error = object
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("host request failed")
                .to_string();
            Ok(HostEvent::Response {
                id,
                result: Err(error),
            })
        }
        None => Err("host response status is invalid".to_string()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chunked_response_is_reassembled_in_order() {
        let mut chunks = HashMap::new();
        let first = r#"{"id":"native-1","chunk":"{\"id\":\"native-1\",\"ok\":true,\"result\":","sequence":0,"end":false}"#;
        let second = r#"{"id":"native-1","chunk":"{\"ready\":true}}","sequence":1,"end":true}"#;
        assert!(parse_line(first, &mut chunks).unwrap().is_none());
        let event = parse_line(second, &mut chunks).unwrap().unwrap();
        match event {
            HostEvent::Response { id, result } => {
                assert_eq!(id, "native-1");
                assert_eq!(result.unwrap()["ready"], true);
            }
            HostEvent::Error(_) | HostEvent::DueJob(_) => panic!(),
        }
    }

    #[test]
    fn request_methods_and_params_are_restricted() {
        let (commands, _command_receiver) = async_channel::bounded(COMMAND_QUEUE_CAPACITY);
        let (_, events) = async_channel::bounded(EVENT_QUEUE_CAPACITY);
        let client = HostClient {
            commands,
            events,
            next_id: Arc::new(AtomicU64::new(1)),
        };
        assert!(client.request("unknown", json!({})).is_err());
        assert!(client.request("thread", json!("bad")).is_err());
        assert!(client.request("thread", json!({"threadId":"a"})).is_ok());
    }
}
