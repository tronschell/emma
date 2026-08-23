use std::{env, path::PathBuf};

use emma_core::{JobSink, LiveClient, LiveError, start_live_runtime};

/// Brings up the store. Nothing here talks to a model: the app process owns every
/// provider call and hands the results back through the same request door as any
/// other write, so the host stays one-directional.
pub fn start(job_sink: JobSink) -> Result<LiveClient, LiveError> {
    let data_root = match env::var_os("EMMA_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => default_data_root()?,
    };
    start_live_runtime(
        data_root.join("threads"),
        data_root.join("knowledge"),
        knowledge_export_root(),
        data_root.join("scheduled"),
        data_root.join("research"),
        job_sink,
    )
}

fn default_data_root() -> Result<PathBuf, LiveError> {
    let home = env::var_os("HOME")
        .ok_or_else(|| LiveError::new("HOME is unset; set EMMA_DATA_DIR to a writable folder"))?;
    Ok(PathBuf::from(home).join("Library/Application Support/Emma"))
}

/// Where the knowledge base is readable by everything else on this Mac: a plain
/// folder of Markdown, not the app's own storage. `EMMA_KNOWLEDGE_DIR` moves it;
/// an empty value turns the mirror off.
fn knowledge_export_root() -> Option<PathBuf> {
    match env::var_os("EMMA_KNOWLEDGE_DIR") {
        Some(path) if path.is_empty() => None,
        Some(path) => Some(PathBuf::from(path)),
        None => {
            env::var_os("HOME").map(|home| PathBuf::from(home).join("Documents/Emma Knowledge"))
        }
    }
}
