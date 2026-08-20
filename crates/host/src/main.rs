use std::io::{self, BufRead, Read, Write};

use emma_core::{KnowledgeBaseId, LiveClient, PageId, ThreadId};
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
struct NameParams {
    name: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ThreadParams {
    thread_id: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct MessageParams {
    thread_id: String,
    content: String,
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

fn main() {
    if let Err(error) = run() {
        eprintln!("Emma host: {error}");
        std::process::exit(1);
    }
}

fn run() -> Result<(), String> {
    let live = runtime::start().map_err(|error| error.to_string())?;
    serve(io::stdin().lock(), io::stdout().lock(), &live)
}

fn serve(
    mut reader: impl BufRead,
    mut writer: impl Write,
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
        serde_json::to_writer(&mut writer, &response)
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
            "createThread" => encode(call(live.create_thread())?),
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
            "sendMessage" => {
                let params: MessageParams = params(request)?;
                encode(call(live.send_message(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                    params.content,
                ))?)
            }
            "saveToKnowledge" => {
                let params: ThreadParams = params(request)?;
                encode(call(live.save_to_knowledge(
                    ThreadId::parse(params.thread_id).map_err(|error| error.to_string())?,
                ))?)
            }
            "listOpenRouterModels" => encode(call(live.list_openrouter_models())?),
            "selectOpenRouterModel" => {
                let params: ModelParams = params(request)?;
                encode(call(live.select_openrouter_model(params.model_id))?)
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
