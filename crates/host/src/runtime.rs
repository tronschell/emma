use std::{env, ffi::OsString, path::PathBuf};

use emma_core::{JobSink, LiveClient, LiveError, start_live_runtime};

pub fn start(job_sink: JobSink) -> Result<LiveClient, LiveError> {
    let data_root = match configured_data_root()? {
        Some(path) => path,
        None => default_data_root()?,
    };
    start_live_runtime(
        data_root.join("threads"),
        data_root.join("scheduled"),
        data_root.join("research"),
        job_sink,
    )
}

fn configured_data_root() -> Result<Option<PathBuf>, LiveError> {
    configured_data_root_from(|name| env::var_os(name))
}

fn configured_data_root_from(
    mut get: impl FnMut(&str) -> Option<OsString>,
) -> Result<Option<PathBuf>, LiveError> {
    let Some(value) = get("EMMA_DATA_DIR") else {
        return Ok(None);
    };
    let path = PathBuf::from(value);
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(LiveError::new(
            "EMMA_DATA_DIR must be a non-empty absolute path",
        ));
    }
    Ok(Some(path))
}

fn default_data_root() -> Result<PathBuf, LiveError> {
    default_data_root_from(|name| env::var_os(name))
}

fn default_data_root_from(
    mut get: impl FnMut(&str) -> Option<std::ffi::OsString>,
) -> Result<PathBuf, LiveError> {
    #[cfg(windows)]
    let (root, user_profile_fallback) = ["APPDATA", "LOCALAPPDATA", "USERPROFILE"]
        .into_iter()
        .find_map(|name| {
            get(name)
                .filter(|value| !value.is_empty())
                .map(|value| (value, name == "USERPROFILE"))
        })
        .ok_or_else(|| {
            LiveError::new(
                "APPDATA, LOCALAPPDATA, and USERPROFILE are unset; set EMMA_DATA_DIR to a writable folder",
            )
        })?;
    #[cfg(not(windows))]
    let root = get("HOME")
        .filter(|value| !value.is_empty())
        .ok_or_else(|| LiveError::new("HOME is unset; set EMMA_DATA_DIR to a writable folder"))?;

    let root = PathBuf::from(root);
    #[cfg(windows)]
    {
        Ok(if user_profile_fallback {
            root.join("AppData/Roaming/Emma")
        } else {
            root.join("Emma")
        })
    }
    #[cfg(not(windows))]
    {
        Ok(root.join("Library/Application Support/Emma"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(unix)]
    #[test]
    fn configured_data_root_requires_an_absolute_nonempty_unix_path() {
        let root = configured_data_root_from(|name| {
            (name == "EMMA_DATA_DIR").then(|| "/var/lib/emma".into())
        })
        .unwrap()
        .unwrap();
        assert_eq!(root, PathBuf::from("/var/lib/emma"));

        assert!(
            configured_data_root_from(|name| {
                (name == "EMMA_DATA_DIR").then(|| "var/lib/emma".into())
            })
            .is_err()
        );
        assert!(
            configured_data_root_from(|name| { (name == "EMMA_DATA_DIR").then(|| "".into()) })
                .is_err()
        );
    }

    #[cfg(windows)]
    #[test]
    fn configured_data_root_requires_an_absolute_nonempty_windows_path() {
        let root = configured_data_root_from(|name| {
            (name == "EMMA_DATA_DIR").then(|| r"C:\EmmaData".into())
        })
        .unwrap()
        .unwrap();
        assert_eq!(root, PathBuf::from(r"C:\EmmaData"));

        assert!(
            configured_data_root_from(|name| {
                (name == "EMMA_DATA_DIR").then(|| r"EmmaData".into())
            })
            .is_err()
        );
        assert!(
            configured_data_root_from(|name| { (name == "EMMA_DATA_DIR").then(|| "".into()) })
                .is_err()
        );
    }

    #[test]
    fn configured_data_root_uses_default_when_unset() {
        assert!(configured_data_root_from(|_| None).unwrap().is_none());
    }

    #[cfg(windows)]
    #[test]
    fn default_data_root_prefers_roaming_app_data_and_falls_back_to_local_data() {
        let root = default_data_root_from(|name| match name {
            "APPDATA" => Some(r"C:\Users\Emma\AppData\Roaming".into()),
            "LOCALAPPDATA" => Some(r"C:\Users\Emma\AppData\Local".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(root, PathBuf::from(r"C:\Users\Emma\AppData\Roaming\Emma"));

        let root = default_data_root_from(|name| match name {
            "LOCALAPPDATA" => Some(r"C:\Users\Emma\AppData\Local".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(root, PathBuf::from(r"C:\Users\Emma\AppData\Local\Emma"));

        let root = default_data_root_from(|name| match name {
            "USERPROFILE" => Some(r"C:\Users\Emma".into()),
            _ => None,
        })
        .unwrap();
        assert_eq!(root, PathBuf::from(r"C:\Users\Emma\AppData\Roaming\Emma"));
    }

    #[cfg(not(windows))]
    #[test]
    fn default_data_root_uses_home_on_unix() {
        let root =
            default_data_root_from(|name| (name == "HOME").then(|| "/Users/Emma".into())).unwrap();
        assert_eq!(
            root,
            PathBuf::from("/Users/Emma/Library/Application Support/Emma")
        );
    }
}
