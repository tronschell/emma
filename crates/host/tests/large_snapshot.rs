use emma_core::{Thread, ThreadMessage, ThreadRole, ThreadStore, ThreadTrace, Timestamp};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    io::{BufRead, BufReader, Write},
    process::{Command, Stdio},
};

#[test]
fn compiled_host_preserves_large_snapshots_and_accepts_the_next_request() {
    let root = std::env::temp_dir().join(format!("emma-host-snapshot-{}", std::process::id()));
    let store = ThreadStore::new(root.join("threads"));
    let now = Timestamp::now();
    let mut expected = BTreeMap::new();
    for index in 0..100 {
        let mut thread = Thread::new(format!("Conversation {index} 🙂"), now).unwrap();
        for turn in 0..8 {
            for role in [ThreadRole::User, ThreadRole::Assistant] {
                thread
                    .push(
                        ThreadMessage::new(
                            role,
                            format!("{turn} {}", "🙂漢字\\\"\n".repeat(1500)),
                            now,
                        )
                        .unwrap(),
                    )
                    .unwrap();
            }
        }
        thread.record_trace(ThreadTrace::new(now, "trace 🙂\n#1 bash 1ms ok").unwrap());
        store.save(&thread).unwrap();
        expected.insert(thread.id.to_string(), serde_json::to_value(thread).unwrap());
    }
    let mut child = Command::new(env!("CARGO_BIN_EXE_emma-host"))
        .env("EMMA_DATA_DIR", &root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut input = child.stdin.take().unwrap();
    let mut output = BufReader::new(child.stdout.take().unwrap());
    writeln!(
        input,
        "{}",
        json!({"id":"snapshot", "method":"snapshot", "params":{}})
    )
    .unwrap();
    let mut assembled = String::new();
    let mut sequence = 0;
    loop {
        let mut line = String::new();
        assert!(output.read_line(&mut line).unwrap() > 0);
        assert!(line.len() < 16 * 1024 * 1024);
        let frame: Value = serde_json::from_str(&line).unwrap();
        assert_eq!(frame["id"], "snapshot");
        assert_eq!(frame["sequence"], sequence);
        let chunk = frame["chunk"].as_str().unwrap();
        assert!(chunk.len() <= 64 * 1024);
        assembled.push_str(chunk);
        sequence += 1;
        if frame["end"] == true {
            break;
        }
    }
    assert!(assembled.len() > 16 * 1024 * 1024);
    let response: Value = serde_json::from_str(&assembled).unwrap();
    assert_eq!(response["ok"], true);
    let actual: BTreeMap<_, _> = response["result"]["threads"]
        .as_array()
        .unwrap()
        .iter()
        .map(|thread| (thread["id"].as_str().unwrap().to_owned(), thread.clone()))
        .collect();
    assert_eq!(actual, expected);
    writeln!(
        input,
        "{}",
        json!({"id":"summaries", "method":"threadSummaries", "params":{}})
    )
    .unwrap();
    let mut summaries = String::new();
    let mut summary_sequence = 0;
    let mut line = String::new();
    assert!(output.read_line(&mut line).unwrap() > 0);
    let mut frame: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(frame["id"], "summaries");
    if frame["chunk"].is_string() {
        loop {
            assert_eq!(frame["sequence"], summary_sequence);
            summaries.push_str(frame["chunk"].as_str().unwrap());
            summary_sequence += 1;
            if frame["end"] == true {
                break;
            }
            line.clear();
            assert!(output.read_line(&mut line).unwrap() > 0);
            let next: Value = serde_json::from_str(&line).unwrap();
            assert_eq!(next["id"], "summaries");
            frame = next;
        }
    } else {
        summaries = line;
    }
    let summary_response: Value = serde_json::from_str(&summaries).unwrap();
    assert_eq!(summary_response["ok"], true);
    let summary = &summary_response["result"]["threads"][0];
    assert_eq!(summary["messages"], 16);
    assert_eq!(summary["userMessageCount"], 8);
    assert_eq!(summary["messageDates"].as_array().unwrap().len(), 16);
    assert!(summary["messages"].is_number());
    assert!(summary["messages"].as_array().is_none());
    assert!(summary["content"].is_null());
    let selected_id = expected.keys().next().unwrap();
    writeln!(
        input,
        "{}",
        json!({"id":"thread", "method":"thread", "params":{"threadId":selected_id}})
    )
    .unwrap();
    let mut thread_response = String::new();
    let mut thread_sequence = 0;
    let mut line = String::new();
    assert!(output.read_line(&mut line).unwrap() > 0);
    let mut frame: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(frame["id"], "thread");
    if frame["chunk"].is_string() {
        loop {
            assert_eq!(frame["sequence"], thread_sequence);
            thread_response.push_str(frame["chunk"].as_str().unwrap());
            thread_sequence += 1;
            if frame["end"] == true {
                break;
            }
            line.clear();
            assert!(output.read_line(&mut line).unwrap() > 0);
            frame = serde_json::from_str(&line).unwrap();
            assert_eq!(frame["id"], "thread");
        }
    } else {
        thread_response = line;
    }
    let thread_response: Value = serde_json::from_str(&thread_response).unwrap();
    assert_eq!(thread_response["ok"], true);
    assert_eq!(thread_response["result"], expected[selected_id]);
    writeln!(
        input,
        "{}",
        json!({"id":"next", "method":"createThread", "params":{"title":"Still healthy"}})
    )
    .unwrap();
    let mut line = String::new();
    output.read_line(&mut line).unwrap();
    let response: Value = serde_json::from_str(&line).unwrap();
    assert_eq!(response["id"], "next");
    assert_eq!(response["ok"], true);
    assert_eq!(response["result"]["title"], "Still healthy");
    drop(input);
    assert!(child.wait().unwrap().success());
    std::fs::remove_dir_all(root).unwrap();
}
