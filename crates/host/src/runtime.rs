use std::{env, path::PathBuf};

use emma_core::{JobSink, LiveClient, LiveError, start_live_runtime};

pub fn start(job_sink: JobSink) -> Result<LiveClient, LiveError> {
    let data_root = match env::var_os("EMMA_DATA_DIR") {
        Some(path) => PathBuf::from(path),
        None => default_data_root()?,
    };
    start_live_runtime(
        data_root.join("threads"),
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
