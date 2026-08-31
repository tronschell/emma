use std::{
    io::{self, BufRead, Read, Write},
    sync::{Arc, Mutex},
};

use emma_core::{
    DueJob, GoalStatus, LiveClient, ResearchJobId, ScheduledJobId, ThreadId, ThreadKind,
};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_REQUEST_BYTES: usize = 128 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Request {
    id: String,
    method: String,
    #[serde(default)]
    params: Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadParams {
    thread_id: String,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateThreadParams {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    parent_thread_id: Option<String>,
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordTurnParams {
    thread_id: String,
    prompt: String,
    response: String,
    output_tokens: Option<String>,
    duration_milliseconds: Option<String>,
    input_tokens: Option<String>,
    cache_input_tokens: Option<String>,
    cache_read_tokens: Option<String>,
    cache_write_tokens: Option<String>,
    cost_micro_usd: Option<String>,
    model: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetGoalParams {
    thread_id: String,
    objective: String,
    token_budget: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdateGoalParams {
    thread_id: String,
    status: Option<String>,
    evidence: Option<String>,
    reason: Option<String>,
    extra_tokens: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordTraceParams {
    thread_id: String,
    trace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveScheduledJobParams {
    #[serde(default)]
    job_id: String,
    title: String,
    schedule: String,
    prompt: String,
    #[serde(default)]
    nodes: String,
    source_domains: String,
    permission_mode: String,
    #[serde(default)]
    model: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ScheduledJobParams {
    job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RunScheduledJobParams {
    job_id: String,
    #[serde(default)]
    variables: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FinishScheduledJobParams {
    job_id: String,
    outputs: String,
    depth: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FireScheduledEventParams {
    event: String,
    #[serde(default)]
    variables: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveResearchJobParams {
    job_id: Option<String>,
    title: String,
    project_dir: String,
    metric_name: String,
    metric_kind: String,
    metric_prompt: Option<String>,
    direction: String,
    eval_command: String,
    prompt: Option<String>,
    proposer_model: String,
    permission_mode: String,
    max_seconds: String,
    max_tokens: String,
    max_micro_dollars: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ResearchJobParams {
    job_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetResearchJobStatusParams {
    job_id: String,
    status: String,
    note: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetResearchJobThreadParams {
    job_id: String,
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordResearchIterationParams {
    job_id: String,
    outcome: String,
    duration_milliseconds: String,
    input_tokens: String,
    output_tokens: String,
    micro_dollars: String,
    value: Option<String>,
    note: Option<String>,
    commit: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetThreadArchivedParams {
    thread_id: String,
    archived: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RenameThreadParams {
    thread_id: String,
    title: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SetScheduledJobEnabledParams {
    job_id: String,
    enabled: String,
}

fn main() {
    if let Err(error) = run() {
        eprintln!("Emma host: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let out = Arc::new(Mutex::new(io::stdout()));
    let jobs = Arc::clone(&out);
    let live = runtime::start(Arc::new(move |job: DueJob| {
        let Ok(mut line) = serde_json::to_vec(&json!({ "dueJob": job })) else {
            return;
        };
        line.push(b'\n');
        if let Ok(mut writer) = jobs.lock() {
            let _ = writer.write_all(&line);
            let _ = writer.flush();
        }
    }))
    .map_err(|error| error.to_string())?;
    serve(io::stdin().lock(), &out, &live)
}

fn serve(
    mut reader: impl BufRead,
    writer: &Mutex<impl Write>,
    live: &LiveClient,
) -> Result<(), String> {
    let mut line = Vec::with_capacity(MAX_REQUEST_BYTES);
    while let Some(request) = read_request(&mut reader, &mut line)
        .map_err(|error| format!("could not read request: {error}"))?
    {
        let response = match request.and_then(|request| dispatch(live, &request)) {
            Ok((id, result)) => json!({ "id": id, "ok": true, "result": result }),
            Err((id, error)) => json!({ "id": id, "ok": false, "error": error }),
        };
        write_response(writer, &response)?;
    }
    Ok(())
}

const RESPONSE_CHUNK_BYTES: usize = 64 * 1024;

fn write_response(writer: &Mutex<impl Write>, response: &Value) -> Result<(), String> {
    let encoded = serde_json::to_string(response)
        .map_err(|error| format!("could not encode response: {error}"))?;
    let write_line = |line: &str| -> Result<(), String> {
        let mut writer = writer
            .lock()
            .map_err(|_| "Emma host output lock was poisoned".to_string())?;
        writer
            .write_all(line.as_bytes())
            .and_then(|()| writer.write_all(b"\n"))
            .and_then(|()| writer.flush())
            .map_err(|error| format!("could not write response: {error}"))
    };
    if encoded.len() <= RESPONSE_CHUNK_BYTES {
        return write_line(&encoded);
    }
    let mut offset = 0;
    let mut sequence = 0;
    while offset < encoded.len() {
        let mut end = (offset + RESPONSE_CHUNK_BYTES).min(encoded.len());
        while !encoded.is_char_boundary(end) {
            end -= 1;
        }
        write_line(
            &json!({
                "id": response["id"],
                "chunk": &encoded[offset..end],
                "sequence": sequence,
                "end": end == encoded.len(),
            })
            .to_string(),
        )?;
        offset = end;
        sequence += 1;
    }
    Ok(())
}

fn read_request(
    reader: &mut impl BufRead,
    line: &mut Vec<u8>,
) -> io::Result<Option<Result<Request, (String, String)>>> {
    line.clear();
    let read = reader
        .take(MAX_REQUEST_BYTES as u64)
        .read_until(b'\n', line)?;
    if read == 0 {
        return Ok(None);
    }

    if line.last() != Some(&b'\n')
        && line.len() == MAX_REQUEST_BYTES
        && !consume_line_ending(reader)?
    {
        discard_line(reader)?;
        return Ok(Some(Err((
            recover_request_id(line).unwrap_or_default(),
            "request is too large".into(),
        ))));
    }
    if line.last() == Some(&b'\n') {
        line.pop();
    }
    if line.last() == Some(&b'\r') {
        line.pop();
    }

    let id = recover_request_id(line).unwrap_or_default();
    let request = std::str::from_utf8(line)
        .map_err(|error| (id, format!("request is not valid UTF-8: {error}")))
        .and_then(parse_request);
    Ok(Some(request))
}

fn consume_line_ending(reader: &mut impl BufRead) -> io::Result<bool> {
    match reader.fill_buf()?.first().copied() {
        None => Ok(true),
        Some(b'\n') => {
            reader.consume(1);
            Ok(true)
        }
        Some(b'\r') => {
            reader.consume(1);
            if reader.fill_buf()?.first() == Some(&b'\n') {
                reader.consume(1);
                Ok(true)
            } else {
                Ok(false)
            }
        }
        Some(_) => Ok(false),
    }
}

fn discard_line(reader: &mut impl BufRead) -> io::Result<()> {
    loop {
        let buffer = reader.fill_buf()?;
        if buffer.is_empty() {
            return Ok(());
        }
        let newline = buffer.iter().position(|byte| *byte == b'\n');
        let consumed = newline.map_or(buffer.len(), |index| index + 1);
        reader.consume(consumed);
        if newline.is_some() {
            return Ok(());
        }
    }
}

fn parse_request(line: &str) -> Result<Request, (String, String)> {
    if line.len() > MAX_REQUEST_BYTES {
        return Err((
            recover_request_id(line.as_bytes()).unwrap_or_default(),
            "request is too large".into(),
        ));
    }
    let id = recover_request_id(line.as_bytes()).unwrap_or_default();
    let request: Request = serde_json::from_str(line)
        .map_err(|error| (id, format!("invalid request JSON: {error}")))?;
    if !valid_request_id(&request.id) {
        return Err((String::new(), "request ID is invalid".into()));
    }
    Ok(request)
}

fn recover_request_id(line: &[u8]) -> Option<String> {
    let mut index = 0;
    skip_json_whitespace(line, &mut index);
    if line.get(index) != Some(&b'{') {
        return None;
    }
    index += 1;
    skip_json_whitespace(line, &mut index);
    if !line.get(index..)?.starts_with(b"\"id\"") {
        return None;
    }
    index += 4;
    skip_json_whitespace(line, &mut index);
    if line.get(index) != Some(&b':') {
        return None;
    }
    index += 1;
    skip_json_whitespace(line, &mut index);
    if line.get(index) != Some(&b'\"') {
        return None;
    }
    index += 1;
    let start = index;
    while let Some(byte) = line.get(index).copied() {
        match byte {
            b'\"' => break,
            b'\\' | 0..=0x1f => return None,
            _ => index += 1,
        }
    }
    if line.get(index) != Some(&b'\"') {
        return None;
    }
    let id = std::str::from_utf8(&line[start..index]).ok()?;
    if !valid_request_id(id) {
        return None;
    }
    index += 1;
    skip_json_whitespace(line, &mut index);
    matches!(line.get(index), Some(b',' | b'}')).then(|| id.to_owned())
}

fn skip_json_whitespace(line: &[u8], index: &mut usize) {
    while line
        .get(*index)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t' | b'\r' | b'\n'))
    {
        *index += 1;
    }
}

fn valid_request_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|byte| byte.is_ascii_graphic())
}

fn optional_u64(value: Option<String>, name: &str) -> Result<Option<u64>, String> {
    value
        .map(|raw| raw.parse::<u64>().map_err(|_| format!("{name} is invalid")))
        .transpose()
}

fn dispatch(live: &LiveClient, request: &Request) -> Result<(String, Value), (String, String)> {
    let result = (|| -> Result<Value, String> {
        match request.method.as_str() {
            "snapshot" => encode(call(live.snapshot())?),
            "createThread" => {
                let params: CreateThreadParams = if request.params.is_null() {
                    CreateThreadParams::default()
                } else {
                    params(request)?
                };
                let parent = params
                    .parent_thread_id
                    .map(ThreadId::parse)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                let kind = match params.kind.as_deref() {
                    Some("subagent") => ThreadKind::Subagent,
                    _ => ThreadKind::Main,
                };
                encode(call(live.create_thread(params.title, parent, kind))?)
            }
            "setThreadArchived" => {
                let params: SetThreadArchivedParams = params(request)?;
                let archived = match params.archived.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => return Err("thread archived state is invalid".into()),
                };
                encode(call(live.set_thread_archived(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    archived,
                ))?)
            }
            "renameThread" => {
                let params: RenameThreadParams = params(request)?;
                encode(call(live.rename_thread(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    params.title,
                ))?)
            }
            "recordTurn" => {
                let params: RecordTurnParams = params(request)?;
                let output_tokens =
                    optional_u64(params.output_tokens, "output tokens")?.unwrap_or_default();
                let duration_milliseconds =
                    optional_u64(params.duration_milliseconds, "duration milliseconds")?
                        .unwrap_or_default();
                let input_tokens =
                    optional_u64(params.input_tokens, "input tokens")?.unwrap_or_default();
                let cache_input_tokens =
                    optional_u64(params.cache_input_tokens, "cache input tokens")?;
                let cache_read_tokens =
                    optional_u64(params.cache_read_tokens, "cache read tokens")?;
                let cache_write_tokens =
                    optional_u64(params.cache_write_tokens, "cache write tokens")?;
                let cost_micro_usd = optional_u64(params.cost_micro_usd, "cost micro-USD")?;
                encode(call(live.record_turn(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    params.prompt,
                    params.response,
                    output_tokens,
                    duration_milliseconds,
                    input_tokens,
                    cache_input_tokens,
                    cache_read_tokens,
                    cache_write_tokens,
                    cost_micro_usd,
                    params.model.unwrap_or_default(),
                ))?)
            }
            "setGoal" => {
                let params: SetGoalParams = params(request)?;
                encode(call(
                    live.set_goal(
                        ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                        params.objective,
                        params
                            .token_budget
                            .and_then(|value| value.parse().ok())
                            .unwrap_or_default(),
                    ),
                )?)
            }
            "updateGoal" => {
                let params: UpdateGoalParams = params(request)?;
                let status = match params.status.as_deref() {
                    None | Some("") => None,
                    Some(value) => Some(
                        value
                            .parse::<GoalStatus>()
                            .map_err(|error| error.to_string())?,
                    ),
                };
                encode(call(
                    live.update_goal(
                        ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                        status,
                        params.evidence.unwrap_or_default(),
                        params.reason.unwrap_or_default(),
                        params
                            .extra_tokens
                            .and_then(|value| value.parse().ok())
                            .unwrap_or_default(),
                    ),
                )?)
            }
            "clearGoal" => {
                let params: ThreadParams = params(request)?;
                encode(call(live.clear_goal(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "recordTrace" => {
                let params: RecordTraceParams = params(request)?;
                call(live.record_trace(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    params.trace,
                ))?;
                Ok(json!({ "recorded": true }))
            }
            "readTrace" => {
                let params: ThreadParams = params(request)?;
                encode(call(live.read_trace(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "saveScheduledJob" => {
                let params: SaveScheduledJobParams = params(request)?;
                let source_domains: Vec<String> = serde_json::from_str(&params.source_domains)
                    .map_err(|_| "scheduled job source domains are invalid".to_string())?;
                let job_id = match params.job_id.as_str() {
                    "" => None,
                    value => Some(ScheduledJobId::parse(value).map_err(|error| error.to_string())?),
                };
                encode(call(live.save_scheduled_job(
                    job_id,
                    params.title,
                    params.schedule,
                    params.prompt,
                    params.nodes,
                    source_domains,
                    params.permission_mode,
                    params.model,
                ))?)
            }
            "deleteScheduledJob" => {
                let params: ScheduledJobParams = params(request)?;
                encode(call(live.delete_scheduled_job(
                    ScheduledJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "runScheduledJob" => {
                let params: RunScheduledJobParams = params(request)?;
                encode(call(live.run_scheduled_job(
                    ScheduledJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                    params.variables,
                ))?)
            }
            "finishScheduledJob" => {
                let params: FinishScheduledJobParams = params(request)?;
                let depth: u32 = params
                    .depth
                    .parse()
                    .map_err(|_| "trigger depth is invalid".to_string())?;
                encode(call(live.finish_scheduled_job(
                    ScheduledJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                    params.outputs,
                    depth,
                ))?)
            }
            "fireScheduledEvent" => {
                let params: FireScheduledEventParams = params(request)?;
                encode(call(
                    live.fire_scheduled_event(params.event, params.variables),
                )?)
            }
            "setScheduledJobEnabled" => {
                let params: SetScheduledJobEnabledParams = params(request)?;
                let enabled = match params.enabled.as_str() {
                    "true" => true,
                    "false" => false,
                    _ => return Err("scheduled job enabled state is invalid".into()),
                };
                encode(call(live.set_scheduled_job_enabled(
                    ScheduledJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                    enabled,
                ))?)
            }
            "saveResearchJob" => {
                let params: SaveResearchJobParams = params(request)?;
                let job_id = params
                    .job_id
                    .map(ResearchJobId::parse)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                encode(call(live.save_research_job(
                    job_id,
                    params.title,
                    params.project_dir,
                    params.metric_name,
                    params.metric_kind,
                    params.metric_prompt.unwrap_or_default(),
                    params.direction,
                    params.eval_command,
                    params.prompt.unwrap_or_default(),
                    params.proposer_model,
                    params.permission_mode,
                    whole_number("maxSeconds", &params.max_seconds)?,
                    whole_number("maxTokens", &params.max_tokens)?,
                    whole_number("maxMicroDollars", &params.max_micro_dollars)?,
                ))?)
            }
            "deleteResearchJob" => {
                let params: ResearchJobParams = params(request)?;
                encode(call(live.delete_research_job(
                    ResearchJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "setResearchJobStatus" => {
                let params: SetResearchJobStatusParams = params(request)?;
                encode(call(live.set_research_job_status(
                    ResearchJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                    params.status,
                    params.note.unwrap_or_default(),
                ))?)
            }
            "setResearchJobThread" => {
                let params: SetResearchJobThreadParams = params(request)?;
                encode(call(live.set_research_job_thread(
                    ResearchJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "recordResearchIteration" => {
                let params: RecordResearchIterationParams = params(request)?;
                let value = params
                    .value
                    .map(|value| measurement("value", &value))
                    .transpose()?;
                encode(call(live.record_research_iteration(
                    ResearchJobId::parse(params.job_id).map_err(|error| error.to_string())?,
                    value,
                    params.outcome,
                    params.note.unwrap_or_default(),
                    params.commit.unwrap_or_default(),
                    whole_number("durationMilliseconds", &params.duration_milliseconds)?,
                    whole_number("inputTokens", &params.input_tokens)?,
                    whole_number("outputTokens", &params.output_tokens)?,
                    whole_number("microDollars", &params.micro_dollars)?,
                ))?)
            }
            _ => Err("method is not allowed".into()),
        }
    })()
    .map_err(|error| (request.id.clone(), error))?;
    Ok((request.id.clone(), result))
}

fn params<T: for<'de> Deserialize<'de>>(request: &Request) -> Result<T, String> {
    serde_json::from_value(request.params.clone())
        .map_err(|error| format!("invalid {} parameters: {error}", request.method))
}

fn whole_number(name: &str, value: &str) -> Result<u64, String> {
    value.parse().map_err(|_| format!("{name} is not a number"))
}

fn measurement(name: &str, value: &str) -> Result<f64, String> {
    match value.parse::<f64>() {
        Ok(number) if number.is_finite() => Ok(number),
        _ => Err(format!("{name} is not a number")),
    }
}

fn encode(value: impl serde::Serialize) -> Result<Value, String> {
    serde_json::to_value(value).map_err(|error| format!("could not encode result: {error}"))
}

fn call<T>(result: Result<T, emma_core::LiveError>) -> Result<T, String> {
    result.map_err(|error| error.to_string())
}

mod runtime;

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn protocol_rejects_unknown_fields_and_oversized_ids() {
        assert!(parse_request(r#"{"id":"1","method":"snapshot","extra":true}"#).is_err());
        let long = "x".repeat(129);
        assert!(parse_request(&format!(r#"{{"id":"{long}","method":"snapshot"}}"#)).is_err());
        assert!(parse_request(r#"{"id":"1","method":"snapshot"}"#).is_ok());
    }

    #[test]
    fn oversized_request_is_bounded_and_does_not_consume_the_next_request() {
        let mut input = br#"{"id":"too-big","method":"snapshot","padding":""#.to_vec();
        input.resize(MAX_REQUEST_BYTES + 32, b'x');
        input.extend_from_slice(
            br#""}
{"id":"next","method":"snapshot"}
"#,
        );
        let mut reader = Cursor::new(input);
        let mut line = Vec::with_capacity(MAX_REQUEST_BYTES);

        let oversized = read_request(&mut reader, &mut line).unwrap().unwrap();
        assert!(oversized.is_err());
        let (id, error) = oversized.err().unwrap();
        assert_eq!(id, "too-big");
        assert_eq!(error, "request is too large");
        assert!(line.len() <= MAX_REQUEST_BYTES);

        let request = read_request(&mut reader, &mut line)
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(request.id, "next");
        assert!(read_request(&mut reader, &mut line).unwrap().is_none());

        let mut exact = br#"{"id":"exact","method":"snapshot","params":{"padding":""#.to_vec();
        exact.resize(MAX_REQUEST_BYTES - 3, b'x');
        exact.extend_from_slice(br#""}}"#);
        assert_eq!(exact.len(), MAX_REQUEST_BYTES);
        let mut exact_reader = Cursor::new(exact);
        let request = read_request(&mut exact_reader, &mut line)
            .unwrap()
            .unwrap()
            .unwrap();
        assert_eq!(request.id, "exact");
    }
}
