use std::{
    io::{self, BufRead, Read, Write},
    sync::{Arc, Mutex},
};

use emma_core::{
    AgentTool, AgentToolResult, ArtifactBlock, DueJob, KnowledgeBaseId, LiveClient,
    MAX_AGENT_TOOLS, PageId, ResearchJobId, ScheduledJobId, ScreenContext, SkillContext, ThreadId,
    ThreadKind,
};
use serde::Deserialize;
use serde_json::{Value, json};

const MAX_REQUEST_BYTES: usize = 128 * 1024;
const MAX_ARTIFACT_EDIT_BYTES: usize = 96 * 1024;

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
struct NameParams {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadParams {
    thread_id: String,
}

/// All three fields are main's to set: the renderer's allowlist carries none of
/// them, so a compromised window cannot graft a thread onto someone else's agent
/// tree, nor hide one from the projects list by calling it a subagent's.
#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CreateThreadParams {
    #[serde(default)]
    title: Option<String>,
    #[serde(default)]
    parent_thread_id: Option<String>,
    /// `"subagent"` for a delegated `task` transcript. Anything else is a thread
    /// the user talks to, which is the safe default for a missing field.
    #[serde(default)]
    kind: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageParams {
    thread_id: String,
    content: String,
    screen_context: Option<String>,
    skill_context: Option<String>,
    /// JSON array of tool definitions. Present only for a granted computer-use
    /// run; an ordinary turn advertises nothing.
    tools: Option<String>,
}

/// A turn the coding harness already ran, on its way into the durable thread.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordTurnParams {
    thread_id: String,
    prompt: String,
    response: String,
    /// The protocol carries every parameter as a string, numbers included.
    output_tokens: Option<String>,
    duration_milliseconds: Option<String>,
    /// Everything the provider billed as input: system prompt, tool schemas and
    /// history included. Absent when the harness reported no usage.
    input_tokens: Option<String>,
    /// Which model answered, as the composer's picker named it. Absent from an
    /// older client; the turn then records no model rather than being refused.
    model: Option<String>,
}

/// One finished turn's execution trace, already rendered by
/// `desktop/shared/trace.ts`. Core clamps it again before it lands on the thread.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct RecordTraceParams {
    thread_id: String,
    trace: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ToolResultParams {
    thread_id: String,
    results: String,
    screen_context: Option<String>,
    skill_context: Option<String>,
    tools: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct WireToolDefinition {
    name: String,
    description: String,
    input_schema: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct WireToolResult {
    id: String,
    content: String,
}

fn agent_tools(value: Option<String>) -> Result<Vec<AgentTool>, String> {
    let Some(raw) = value else {
        return Ok(Vec::new());
    };
    let parsed: Vec<WireToolDefinition> =
        serde_json::from_str(&raw).map_err(|_| "tool definitions are invalid JSON".to_string())?;
    if parsed.len() > MAX_AGENT_TOOLS {
        return Err("too many tools for one turn".into());
    }
    parsed
        .into_iter()
        .map(|tool| {
            AgentTool::new(tool.name, tool.description, tool.input_schema)
                .map_err(|error| error.to_string())
        })
        .collect()
}

fn agent_tool_results(raw: &str) -> Result<Vec<AgentToolResult>, String> {
    let parsed: Vec<WireToolResult> =
        serde_json::from_str(raw).map_err(|_| "tool results are invalid JSON".to_string())?;
    if parsed.is_empty() || parsed.len() > MAX_AGENT_TOOLS {
        return Err("tool results are invalid".into());
    }
    parsed
        .into_iter()
        .map(|result| {
            AgentToolResult::new(result.id, result.content).map_err(|error| error.to_string())
        })
        .collect()
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SelectBaseParams {
    thread_id: String,
    knowledge_base_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ModelParams {
    model_id: String,
    /// The thinking mode to run the model in; absent leaves the model's own default.
    #[serde(default)]
    effort: String,
}

/// One thread's own model — what a subagent runs on. An empty `modelId` clears it.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadModelParams {
    thread_id: String,
    #[serde(default)]
    model_id: String,
    #[serde(default)]
    effort: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct LocalModelParams {
    base_url: String,
    model_id: String,
    credential_env: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SourcesParams {
    thread_id: String,
    knowledge_base_ids: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CategoryParams {
    knowledge_base_id: String,
    category: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePageParams {
    page_id: String,
    title: String,
    category: String,
    summary: String,
    body: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct UpdatePageDocumentParams {
    page_id: String,
    title: String,
    category: String,
    summary: String,
    body: String,
    artifacts: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct CaptureParams {
    knowledge_base_id: String,
    category: String,
    title: String,
    text: String,
    source_url: Option<String>,
    source_application: Option<String>,
    image: Option<String>,
    /// A JSON array of data URLs, for captures that keep more than one picture.
    images: Option<String>,
    /// The page this re-read replaces, instead of filing a second copy of one URL.
    page_id: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageParams {
    page_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AnalyzeParams {
    page_id: String,
    /// "true" builds the document but leaves the page where it is filed.
    keep_category: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageVersionParams {
    page_id: String,
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageChatParams {
    page_id: String,
    content: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct PageReviseParams {
    page_id: String,
    instruction: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct AssetParams {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct SaveScheduledJobParams {
    /// Empty creates; anything else rewrites that job in place.
    #[serde(default)]
    job_id: String,
    title: String,
    /// Cron, `manual`, `after <job-id>`, or `on <event>`.
    schedule: String,
    prompt: String,
    /// The workflow graph as JSON, or empty for a job that is one step on `prompt`.
    #[serde(default)]
    nodes: String,
    source_domains: String,
    /// The mode this job runs under, forever. An unattended run has nobody to ask.
    permission_mode: String,
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
    /// A JSON object the run starts with, or empty.
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
    /// Absent creates; present rewrites that job in place.
    job_id: Option<String>,
    title: String,
    project_dir: String,
    metric_name: String,
    /// `grep` reads the number out of the run's output; `judge` scores it.
    metric_kind: String,
    /// The judge's rubric. Absent for a grep metric, which takes none.
    metric_prompt: Option<String>,
    direction: String,
    eval_command: String,
    /// What the user wants the proposer to try, in the composer's "/" and "@"
    /// grammar. Absent is a job steered by the loop's own instructions alone.
    prompt: Option<String>,
    proposer_model: String,
    permission_mode: String,
    /// The three budgets, `0` for no limit.
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
    /// Which budget ran out, or what failed. Absent when nothing needs saying.
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
    /// Absent when the run crashed and produced no number at all.
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
    // One lock over stdout, shared with the runtime thread. `serve` only holds
    // it to write a finished response, and it is blocked in `dispatch` for the
    // whole span a turn is streaming, so the two never contend in practice.
    let out = Arc::new(Mutex::new(io::stdout()));
    let sink = Arc::clone(&out);
    let jobs = Arc::clone(&out);
    let live = runtime::start(
        Arc::new(move |thread_id: &str, text: &str| {
            // A dropped chunk is a missed repaint; the turn's own response line still
            // carries the whole message, so nothing here is worth failing the host over.
            if let Ok(mut writer) = sink.lock() {
                let line = json!({ "threadId": thread_id, "delta": text });
                let _ = serde_json::to_writer(&mut *writer, &line);
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
        }),
        Arc::new(move |job: DueJob| {
            // Pushed, not replied to: nothing asked for this, the clock did.
            if let Ok(mut writer) = jobs.lock() {
                let line = json!({ "dueJob": job });
                let _ = serde_json::to_writer(&mut *writer, &line);
                let _ = writer.write_all(b"\n");
                let _ = writer.flush();
            }
        }),
    )
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
        let mut writer = writer
            .lock()
            .map_err(|_| "Emma host output lock was poisoned".to_string())?;
        serde_json::to_writer(&mut *writer, &response)
            .map_err(|error| format!("could not encode response: {error}"))?;
        writer
            .write_all(b"\n")
            .and_then(|()| writer.flush())
            .map_err(|error| format!("could not write response: {error}"))?;
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

fn dispatch(live: &LiveClient, request: &Request) -> Result<(String, Value), (String, String)> {
    let result = (|| -> Result<Value, String> {
        match request.method.as_str() {
            "snapshot" => encode(call(live.snapshot())?),
            "createThread" => {
                // The renderer sends this one with no params at all, which arrives as null.
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
            "createKnowledgeBase" => {
                let params: NameParams = params(request)?;
                encode(call(live.create_knowledge_base(params.name))?)
            }
            "selectThreadKnowledgeBase" => {
                let params: SelectBaseParams = params(request)?;
                encode(call(
                    live.select_thread_knowledge_base(
                        ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                        KnowledgeBaseId::parse(params.knowledge_base_id)
                            .map_err(|error| error.to_string())?,
                    ),
                )?)
            }
            "selectThreadSources" => {
                let params: SourcesParams = params(request)?;
                let ids: Vec<String> = serde_json::from_str(&params.knowledge_base_ids)
                    .map_err(|_| "source base IDs are invalid".to_string())?;
                let ids = ids
                    .into_iter()
                    .map(KnowledgeBaseId::parse)
                    .collect::<Result<Vec<_>, _>>()
                    .map_err(|error| error.to_string())?;
                encode(call(live.select_thread_sources(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    ids,
                ))?)
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
            "addKnowledgeBaseCategory" | "removeKnowledgeBaseCategory" => {
                let params: CategoryParams = params(request)?;
                let id = KnowledgeBaseId::parse(params.knowledge_base_id)
                    .map_err(|error| error.to_string())?;
                encode(call(if request.method == "addKnowledgeBaseCategory" {
                    live.add_knowledge_base_category(id, params.category)
                } else {
                    live.remove_knowledge_base_category(id, params.category)
                })?)
            }
            "updatePage" => {
                let params: UpdatePageParams = params(request)?;
                encode(call(live.update_page(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                    params.title,
                    params.category,
                    params.summary,
                    params.body,
                ))?)
            }
            "updatePageDocument" => {
                let params: UpdatePageDocumentParams = params(request)?;
                if params.artifacts.len() > MAX_ARTIFACT_EDIT_BYTES {
                    return Err("artifact document is too large".into());
                }
                let artifacts: Vec<ArtifactBlock> = serde_json::from_str(&params.artifacts)
                    .map_err(|_| "artifact document is invalid JSON".to_string())?;
                encode(call(live.update_page_document(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                    params.title,
                    params.category,
                    params.summary,
                    params.body,
                    artifacts,
                ))?)
            }
            "sendMessage" => {
                if request
                    .params
                    .get("screenContext")
                    .is_some_and(|value| !value.is_string())
                {
                    return Err(
                        "invalid sendMessage parameters: screen context must be a string".into(),
                    );
                }
                let params: MessageParams = params(request)?;
                let screen_context = params
                    .screen_context
                    .map(ScreenContext::new)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                let skill_context = params
                    .skill_context
                    .map(SkillContext::new)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                encode(call(live.send_message(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    params.content,
                    screen_context,
                    skill_context,
                    agent_tools(params.tools)?,
                ))?)
            }
            "recordTurn" => {
                let params: RecordTurnParams = params(request)?;
                encode(call(
                    live.record_turn(
                        ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                        params.prompt,
                        params.response,
                        params
                            .output_tokens
                            .and_then(|v| v.parse().ok())
                            .unwrap_or_default(),
                        params
                            .duration_milliseconds
                            .and_then(|v| v.parse().ok())
                            .unwrap_or_default(),
                        params
                            .input_tokens
                            .and_then(|v| v.parse().ok())
                            .unwrap_or_default(),
                        params.model.unwrap_or_default(),
                    ),
                )?)
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
            "submitToolResult" => {
                let params: ToolResultParams = params(request)?;
                let screen_context = params
                    .screen_context
                    .map(ScreenContext::new)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                let skill_context = params
                    .skill_context
                    .map(SkillContext::new)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                encode(call(live.submit_tool_result(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    agent_tool_results(&params.results)?,
                    screen_context,
                    skill_context,
                    agent_tools(params.tools)?,
                ))?)
            }
            "saveToKnowledge" => {
                let params: ThreadParams = params(request)?;
                encode(call(live.save_to_knowledge(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "captureToKnowledge" => {
                let params: CaptureParams = params(request)?;
                let mut images: Vec<String> = params.image.into_iter().collect();
                if let Some(list) = params.images {
                    let parsed: Vec<String> = serde_json::from_str(&list)
                        .map_err(|_| "captured images are invalid JSON".to_string())?;
                    images.extend(parsed);
                }
                let page_id = params
                    .page_id
                    .map(PageId::parse)
                    .transpose()
                    .map_err(|error| error.to_string())?;
                encode(call(
                    live.capture_to_knowledge(
                        KnowledgeBaseId::parse(params.knowledge_base_id)
                            .map_err(|error| error.to_string())?,
                        params.category,
                        params.title,
                        params.text,
                        params.source_url,
                        params.source_application,
                        images,
                        page_id,
                    ),
                )?)
            }
            "analyzePage" => {
                let params: AnalyzeParams = params(request)?;
                let keep_category = match params.keep_category.as_deref() {
                    None | Some("false") => false,
                    Some("true") => true,
                    _ => return Err("keepCategory must be \"true\" or \"false\"".into()),
                };
                encode(call(live.analyze_page(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                    keep_category,
                ))?)
            }
            "listPageVersions" => {
                let params: PageParams = params(request)?;
                encode(call(live.list_page_versions(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "restorePageVersion" => {
                let params: PageVersionParams = params(request)?;
                encode(call(live.restore_page_version(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                    params.name,
                ))?)
            }
            "chatAboutPage" => {
                let params: PageChatParams = params(request)?;
                encode(call(live.chat_about_page(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                    params.content,
                ))?)
            }
            "revisePageDocument" => {
                let params: PageReviseParams = params(request)?;
                encode(call(live.revise_page_document(
                    PageId::parse(params.page_id).map_err(|error| error.to_string())?,
                    params.instruction,
                ))?)
            }
            "readPageAsset" => {
                let params: AssetParams = params(request)?;
                encode(call(live.read_page_asset(params.name))?)
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
                // ponytail: enabled arrives as text like every other param; the host
                // protocol is string-valued and this is the one boolean in it.
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
            "listOpenRouterModels" => encode(call(live.list_openrouter_models())?),
            "selectOpenRouterModel" => {
                let params: ModelParams = params(request)?;
                encode(call(
                    live.select_openrouter_model(params.model_id, params.effort),
                )?)
            }
            "setThreadModel" => {
                let params: ThreadModelParams = params(request)?;
                call(live.set_thread_model(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    params.model_id,
                    params.effort,
                ))?;
                Ok(json!({ "set": true }))
            }
            "selectLocalModel" => {
                let params: LocalModelParams = params(request)?;
                encode(call(live.select_local_model(
                    params.base_url,
                    params.model_id,
                    params.credential_env,
                ))?)
            }
            "selectFallbackModel" => encode(call(live.select_fallback_model())?),
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

/// A measured metric. NaN and infinity are refused here as well as in core, because
/// a graph line and a "did it improve" comparison are both meaningless against them.
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
