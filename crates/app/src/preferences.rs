use std::fs::{self, File, OpenOptions};
use std::io::{self, Read, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Map, Value, json};

use crate::pane_layout::PaneLayout;

pub const MAX_PREFERENCE_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_PREFERENCE_KEYS: usize = 128;
pub const MAX_SCOPED_ID_CHARS: usize = 256;
pub const SETTINGS_KEY: &str = "emma.settings.v1";
pub const LAYOUT_KEY: &str = "emma.layout.v2";
pub const IMPORTS_SEEN_KEY: &str = "emma.importsSeen.v1";
pub const SETUP_SEEN_KEY: &str = "emma.setupSeen.v1";
pub const FREE_MODELS_ONLY_KEY: &str = "emma.freeModelsOnly.v1";
pub const MAKER_ORDER_KEY: &str = "emma.makerOrder.v1";
pub const OVERLAY_DRAFT_KEY: &str = "emma.overlayDraft.v1";
pub const OVERLAY_MODE_KEY: &str = "emma.overlayMode.v1";
pub const CONTEXT_PAGE_KEY: &str = "emma.contextPage.v1";
pub const DEFAULT_EDITOR_KEY: &str = "emma.default-editor";
pub const IMPROVEMENTS_KEY: &str = "emma.improvements.v1";
pub const BENCH_KEY: &str = "emma.bench.v1";
pub const WORKTREE_PREFIX_KEY: &str = "emma.worktreePrefix.v1";
pub const THREAD_FOLDERS_KEY: &str = "emma.threadFolders.v1";
pub const THREAD_MODES_KEY: &str = "emma.threadModes.v1";
pub const THREAD_CONTEXT_USES_KEY: &str = "emma.threadContextUses.v2";
pub const THREAD_CONTEXT_BREAKDOWN_KEY: &str = "emma.threadContextBreakdown.v1";
pub const THREAD_BLOCKS_KEY_PREFIX: &str = "emma.threadBlocks.v1.";
pub const THREAD_ATTACHMENTS_KEY_PREFIX: &str = "emma.threadAttachments.v1.";
pub const THREAD_DRAFT_KEY_PREFIX: &str = "emma.threadDraft.v1.";
pub const THREAD_CLEARED_KEY: &str = "emma.threadCleared.v1";
pub const THREAD_EXPERIMENTS_KEY: &str = "emma.threadExperiments.v1";
pub const THREAD_TAGS_KEY: &str = "emma.threadTags.v1";
pub const THREAD_PINS_KEY: &str = "emma.threadPins.v1";
pub const THREAD_UNREAD_KEY: &str = "emma.threadUnread.v1";
pub const THREAD_MODEL_SWITCHES_KEY: &str = "emma.threadModelSwitches.v1";
pub const CATALOG_FILE: &str = "openrouter-catalog.json";

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum PreferenceKey {
    Settings,
    Layout,
    ImportsSeen,
    SetupSeen,
    FreeModelsOnly,
    MakerOrder,
    OverlayDraft,
    OverlayMode,
    ContextPage,
    DefaultEditor,
    Improvements,
    Bench,
    WorktreePrefix,
    ThreadFolders,
    ThreadModes,
    ThreadContextUses,
    ThreadContextBreakdown,
    ThreadCleared,
    ThreadExperiments,
    ThreadTags,
    ThreadPins,
    ThreadUnread,
    ThreadModelSwitches,
    Catalog,
}

impl PreferenceKey {
    pub const ALL: [Self; 24] = [
        Self::Settings,
        Self::Layout,
        Self::ImportsSeen,
        Self::SetupSeen,
        Self::FreeModelsOnly,
        Self::MakerOrder,
        Self::OverlayDraft,
        Self::OverlayMode,
        Self::ContextPage,
        Self::DefaultEditor,
        Self::Improvements,
        Self::Bench,
        Self::WorktreePrefix,
        Self::ThreadFolders,
        Self::ThreadModes,
        Self::ThreadContextUses,
        Self::ThreadContextBreakdown,
        Self::ThreadCleared,
        Self::ThreadExperiments,
        Self::ThreadTags,
        Self::ThreadPins,
        Self::ThreadUnread,
        Self::ThreadModelSwitches,
        Self::Catalog,
    ];

    pub const fn wire_key(self) -> &'static str {
        match self {
            Self::Settings => SETTINGS_KEY,
            Self::Layout => LAYOUT_KEY,
            Self::ImportsSeen => IMPORTS_SEEN_KEY,
            Self::SetupSeen => SETUP_SEEN_KEY,
            Self::FreeModelsOnly => FREE_MODELS_ONLY_KEY,
            Self::MakerOrder => MAKER_ORDER_KEY,
            Self::OverlayDraft => OVERLAY_DRAFT_KEY,
            Self::OverlayMode => OVERLAY_MODE_KEY,
            Self::ContextPage => CONTEXT_PAGE_KEY,
            Self::DefaultEditor => DEFAULT_EDITOR_KEY,
            Self::Improvements => IMPROVEMENTS_KEY,
            Self::Bench => BENCH_KEY,
            Self::WorktreePrefix => WORKTREE_PREFIX_KEY,
            Self::ThreadFolders => THREAD_FOLDERS_KEY,
            Self::ThreadModes => THREAD_MODES_KEY,
            Self::ThreadContextUses => THREAD_CONTEXT_USES_KEY,
            Self::ThreadContextBreakdown => THREAD_CONTEXT_BREAKDOWN_KEY,
            Self::ThreadCleared => THREAD_CLEARED_KEY,
            Self::ThreadExperiments => THREAD_EXPERIMENTS_KEY,
            Self::ThreadTags => THREAD_TAGS_KEY,
            Self::ThreadPins => THREAD_PINS_KEY,
            Self::ThreadUnread => THREAD_UNREAD_KEY,
            Self::ThreadModelSwitches => THREAD_MODEL_SWITCHES_KEY,
            Self::Catalog => CATALOG_FILE,
        }
    }

    pub const fn file_name(self) -> &'static str {
        match self {
            Self::Catalog => CATALOG_FILE,
            Self::DefaultEditor => "emma.default-editor.txt",
            Self::OverlayDraft => "emma.overlayDraft.v1.txt",
            Self::OverlayMode => "emma.overlayMode.v1.txt",
            Self::ImportsSeen => "emma.importsSeen.v1.txt",
            Self::SetupSeen => "emma.setupSeen.v1.txt",
            Self::FreeModelsOnly => "emma.freeModelsOnly.v1.txt",
            Self::ContextPage => "emma.contextPage.v1.txt",
            Self::WorktreePrefix => "emma.worktreePrefix.v1.txt",
            _ => match self {
                Self::Settings => "emma.settings.v1.json",
                Self::Layout => "emma.layout.v2.json",
                Self::MakerOrder => "emma.makerOrder.v1.json",
                Self::Improvements => "emma.improvements.v1.json",
                Self::Bench => "emma.bench.v1.json",
                Self::ThreadFolders => "emma.threadFolders.v1.json",
                Self::ThreadModes => "emma.threadModes.v1.json",
                Self::ThreadContextUses => "emma.threadContextUses.v2.json",
                Self::ThreadContextBreakdown => "emma.threadContextBreakdown.v1.json",
                Self::ThreadCleared => "emma.threadCleared.v1.json",
                Self::ThreadExperiments => "emma.threadExperiments.v1.json",
                Self::ThreadTags => "emma.threadTags.v1.json",
                Self::ThreadPins => "emma.threadPins.v1.json",
                Self::ThreadUnread => "emma.threadUnread.v1.json",
                Self::ThreadModelSwitches => "emma.threadModelSwitches.v1.json",
                Self::Catalog
                | Self::DefaultEditor
                | Self::OverlayDraft
                | Self::OverlayMode
                | Self::ImportsSeen
                | Self::SetupSeen
                | Self::FreeModelsOnly
                | Self::ContextPage
                | Self::WorktreePrefix => unreachable!(),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum ScopedPreference {
    Blocks,
    Attachments,
    Draft,
}

impl ScopedPreference {
    pub const fn wire_prefix(self) -> &'static str {
        match self {
            Self::Blocks => THREAD_BLOCKS_KEY_PREFIX,
            Self::Attachments => THREAD_ATTACHMENTS_KEY_PREFIX,
            Self::Draft => THREAD_DRAFT_KEY_PREFIX,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PreferenceError {
    InvalidKey(String),
    InvalidValue {
        key: String,
        message: String,
    },
    TooLarge {
        path: PathBuf,
        limit: usize,
    },
    Corrupt {
        path: PathBuf,
        backup: Option<PathBuf>,
    },
    Io {
        operation: &'static str,
        path: PathBuf,
        message: String,
    },
    Serialization {
        key: String,
        message: String,
    },
}

impl std::fmt::Display for PreferenceError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::InvalidKey(key) => write!(formatter, "invalid preference key: {key}"),
            Self::InvalidValue { key, message } => write!(formatter, "{key}: {message}"),
            Self::TooLarge { path, limit } => {
                write!(
                    formatter,
                    "{} exceeds the {limit}-byte preference limit",
                    path.display()
                )
            }
            Self::Corrupt { path, backup } => {
                if let Some(backup) = backup {
                    write!(
                        formatter,
                        "{} was corrupt and moved to {}",
                        path.display(),
                        backup.display()
                    )
                } else {
                    write!(formatter, "{} was corrupt", path.display())
                }
            }
            Self::Io {
                operation,
                path,
                message,
            } => write!(formatter, "{operation} {}: {message}", path.display()),
            Self::Serialization { key, message } => write!(formatter, "{key}: {message}"),
        }
    }
}

impl std::error::Error for PreferenceError {}

pub type PreferenceResult<T> = Result<T, PreferenceError>;

#[derive(Clone, Debug)]
pub struct PreferenceStore {
    root: PathBuf,
    max_bytes: usize,
}

impl PreferenceStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            max_bytes: MAX_PREFERENCE_BYTES,
        }
    }

    pub fn with_limit(root: impl Into<PathBuf>, max_bytes: usize) -> PreferenceResult<Self> {
        if max_bytes == 0 || max_bytes > MAX_PREFERENCE_BYTES {
            return Err(PreferenceError::InvalidValue {
                key: "maxBytes".into(),
                message: format!("must be between 1 and {MAX_PREFERENCE_BYTES}"),
            });
        }
        Ok(Self {
            root: root.into(),
            max_bytes,
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn read(&self, key: PreferenceKey) -> PreferenceResult<Option<Value>> {
        self.read_named(key.file_name())
    }

    pub fn read_named(&self, name: &str) -> PreferenceResult<Option<Value>> {
        let path = self.named_path(name)?;
        let Some(bytes) = self.read_bytes(&path)? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| self.corrupt(&path))
    }

    pub fn read_json<T: DeserializeOwned>(
        &self,
        key: PreferenceKey,
    ) -> PreferenceResult<Option<T>> {
        self.read_named_json(key.file_name())
    }

    pub fn read_named_json<T: DeserializeOwned>(&self, name: &str) -> PreferenceResult<Option<T>> {
        let path = self.named_path(name)?;
        let Some(bytes) = self.read_bytes(&path)? else {
            return Ok(None);
        };
        serde_json::from_slice(&bytes)
            .map(Some)
            .map_err(|_| self.corrupt(&path))
    }

    pub fn read_text(&self, key: PreferenceKey) -> PreferenceResult<Option<String>> {
        self.read_named_text(key.file_name())
    }

    pub fn read_named_text(&self, name: &str) -> PreferenceResult<Option<String>> {
        let path = self.named_path(name)?;
        let Some(bytes) = self.read_bytes(&path)? else {
            return Ok(None);
        };
        String::from_utf8(bytes)
            .map(Some)
            .map_err(|_| self.corrupt(&path))
    }

    pub fn write(&self, key: PreferenceKey, value: &Value) -> PreferenceResult<()> {
        self.write_named(key.file_name(), value)
    }

    pub fn write_named(&self, name: &str, value: &Value) -> PreferenceResult<()> {
        let bytes = serde_json::to_vec(value).map_err(|error| PreferenceError::Serialization {
            key: name.to_owned(),
            message: error.to_string(),
        })?;
        self.write_named_bytes(name, &bytes)
    }

    pub fn write_json<T: Serialize>(&self, key: PreferenceKey, value: &T) -> PreferenceResult<()> {
        self.write_named_json(key.file_name(), value)
    }

    pub fn write_named_json<T: Serialize>(&self, name: &str, value: &T) -> PreferenceResult<()> {
        let bytes = serde_json::to_vec(value).map_err(|error| PreferenceError::Serialization {
            key: name.to_owned(),
            message: error.to_string(),
        })?;
        self.write_named_bytes(name, &bytes)
    }

    pub fn write_text(&self, key: PreferenceKey, value: &str) -> PreferenceResult<()> {
        self.write_named_bytes(key.file_name(), value.as_bytes())
    }

    pub fn write_named_text(&self, name: &str, value: &str) -> PreferenceResult<()> {
        self.write_named_bytes(name, value.as_bytes())
    }

    pub fn remove(&self, key: PreferenceKey) -> PreferenceResult<bool> {
        self.remove_named(key.file_name())
    }

    pub fn remove_named(&self, name: &str) -> PreferenceResult<bool> {
        let path = self.named_path(name)?;
        match fs::remove_file(&path) {
            Ok(()) => Ok(true),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
            Err(error) => Err(io_error("remove preference", &path, error)),
        }
    }

    pub fn read_scoped(
        &self,
        scope: ScopedPreference,
        id: &str,
    ) -> PreferenceResult<Option<Value>> {
        self.read_named(&scoped_name(scope, id)?)
    }

    pub fn read_scoped_json<T: DeserializeOwned>(
        &self,
        scope: ScopedPreference,
        id: &str,
    ) -> PreferenceResult<Option<T>> {
        self.read_named_json(&scoped_name(scope, id)?)
    }

    pub fn read_scoped_text(
        &self,
        scope: ScopedPreference,
        id: &str,
    ) -> PreferenceResult<Option<String>> {
        self.read_named_text(&scoped_name(scope, id)?)
    }

    pub fn write_scoped(
        &self,
        scope: ScopedPreference,
        id: &str,
        value: &Value,
    ) -> PreferenceResult<()> {
        self.write_named(&scoped_name(scope, id)?, value)
    }

    pub fn write_scoped_json<T: Serialize>(
        &self,
        scope: ScopedPreference,
        id: &str,
        value: &T,
    ) -> PreferenceResult<()> {
        self.write_named_json(&scoped_name(scope, id)?, value)
    }

    pub fn write_scoped_text(
        &self,
        scope: ScopedPreference,
        id: &str,
        value: &str,
    ) -> PreferenceResult<()> {
        self.write_named_text(&scoped_name(scope, id)?, value)
    }

    pub fn remove_scoped(&self, scope: ScopedPreference, id: &str) -> PreferenceResult<bool> {
        self.remove_named(&scoped_name(scope, id)?)
    }

    pub fn read_layout(&self, viewport_width: f64) -> PreferenceResult<PaneLayout> {
        let value = self.read(PreferenceKey::Layout)?;
        Ok(PaneLayout::from_value(value.as_ref(), viewport_width))
    }

    pub fn write_layout(&self, layout: &PaneLayout) -> PreferenceResult<()> {
        self.write_json(PreferenceKey::Layout, layout)
    }

    pub fn read_settings_or_default(&self, default: Option<Value>) -> PreferenceResult<Value> {
        let fallback = default.unwrap_or_else(default_settings_value);
        let Some(value) = (match self.read(PreferenceKey::Settings) {
            Ok(value) => value,
            Err(PreferenceError::Corrupt { .. }) => None,
            Err(error) => return Err(error),
        }) else {
            return Ok(fallback);
        };
        let migrated = migrate_settings(value)?;
        if validate_settings(&migrated).is_err() {
            let _ = self.quarantine_named(PreferenceKey::Settings.file_name());
            return Ok(fallback);
        }
        Ok(migrated)
    }

    pub fn write_settings(&self, value: &Value) -> PreferenceResult<()> {
        let migrated = migrate_settings(value.clone())?;
        validate_settings(&migrated)?;
        self.write(PreferenceKey::Settings, &migrated)
    }

    pub fn read_scoped_or_default<T: DeserializeOwned>(
        &self,
        scope: ScopedPreference,
        id: &str,
        default: T,
    ) -> PreferenceResult<T> {
        match self.read_scoped_json(scope, id) {
            Ok(Some(value)) => Ok(value),
            Ok(None) | Err(PreferenceError::Corrupt { .. }) => Ok(default),
            Err(error) => Err(error),
        }
    }

    fn named_path(&self, name: &str) -> PreferenceResult<PathBuf> {
        validate_file_name(name)?;
        Ok(self.root.join(name))
    }

    fn read_bytes(&self, path: &Path) -> PreferenceResult<Option<Vec<u8>>> {
        let mut file = match File::open(path) {
            Ok(file) => file,
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(io_error("read preference", path, error)),
        };
        let mut bytes = Vec::new();
        Read::by_ref(&mut file)
            .take((self.max_bytes + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|error| io_error("read preference", path, error))?;
        if bytes.len() > self.max_bytes {
            return Err(self.corrupt(path));
        }
        Ok(Some(bytes))
    }

    fn write_named_bytes(&self, name: &str, bytes: &[u8]) -> PreferenceResult<()> {
        let path = self.named_path(name)?;
        if bytes.len() > self.max_bytes {
            return Err(PreferenceError::TooLarge {
                path,
                limit: self.max_bytes,
            });
        }
        fs::create_dir_all(&self.root)
            .map_err(|error| io_error("create preference directory", &self.root, error))?;
        set_private_directory(&self.root)?;
        let temporary = temporary_path(&path);
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        set_private_file(&mut options);
        let write_result = (|| {
            let mut file = options
                .open(&temporary)
                .map_err(|error| io_error("create preference temporary", &temporary, error))?;
            file.write_all(bytes)
                .map_err(|error| io_error("write preference", &temporary, error))?;
            file.sync_all()
                .map_err(|error| io_error("sync preference", &temporary, error))?;
            fs::rename(&temporary, &path)
                .map_err(|error| io_error("replace preference", &path, error))?;
            Ok::<(), PreferenceError>(())
        })();
        if write_result.is_err() {
            let _ = fs::remove_file(&temporary);
        }
        write_result?;
        if let Ok(directory) = File::open(&self.root) {
            let _ = directory.sync_all();
        }
        Ok(())
    }

    fn corrupt(&self, path: &Path) -> PreferenceError {
        let backup = self.quarantine(path).ok();
        PreferenceError::Corrupt {
            path: path.to_owned(),
            backup,
        }
    }

    fn quarantine_named(&self, name: &str) -> PreferenceResult<Option<PathBuf>> {
        let path = self.named_path(name)?;
        match self.quarantine(&path) {
            Ok(backup) => Ok(Some(backup)),
            Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(None),
            Err(error) => Err(io_error("quarantine preference", &path, error)),
        }
    }

    fn quarantine(&self, path: &Path) -> io::Result<PathBuf> {
        if !path.exists() {
            return Err(io::Error::new(
                io::ErrorKind::NotFound,
                "preference missing",
            ));
        }
        let stamp = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos();
        for index in 0..32u8 {
            let backup = PathBuf::from(format!("{}.corrupt.{stamp}.{index}", path.display()));
            if backup.exists() {
                continue;
            }
            match fs::rename(path, &backup) {
                Ok(()) => return Ok(backup),
                Err(error) if error.kind() == io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error),
            }
        }
        Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            "could not allocate a corruption backup name",
        ))
    }
}

pub fn scoped_name(scope: ScopedPreference, id: &str) -> PreferenceResult<String> {
    validate_scoped_id(id)?;
    Ok(format!("{}{}.json", scope.wire_prefix(), id))
}

pub fn default_settings_value() -> Value {
    let action =
        |label: &str, prompt: &str| json!({"label": label, "prompt": prompt, "category": ""});
    let widget = |kind: &str, orientation: &str| json!({"type": kind, "orientation": orientation});
    let page = |id: &str, name: &str, widgets: Vec<Value>| json!({"id": id, "name": name, "widgets": widgets});
    let mut object = Map::new();
    object.insert(
        "quickActions".into(),
        Value::Array(vec![
            action(
                "Summarize",
                "Summarize the current idea and identify the next step.",
            ),
            action(
                "Research",
                "Research this topic using available knowledge and explain the key findings.",
            ),
            action("Draft", "Turn this idea into a concise working draft."),
        ]),
    );
    object.insert(
        "cursorOrbs".into(),
        json!(["0", "1", "2", "screen", "draw", "page"]),
    );
    object.insert("cursorOrbsEnabled".into(), Value::Bool(false));
    object.insert("notchCommandsEnabled".into(), Value::Bool(true));
    object.insert("notchGap".into(), json!(180));
    object.insert("notchModel".into(), Value::String(String::new()));
    object.insert("notchConcurrency".into(), Value::String("separate".into()));
    object.insert("transcriptionEnabled".into(), Value::Bool(false));
    object.insert("transcriptionEngine".into(), Value::String("apple".into()));
    object.insert(
        "transcriptionEndpoint".into(),
        Value::String("http://127.0.0.1:8080/v1/audio/transcriptions".into()),
    );
    object.insert(
        "transcriptionModel".into(),
        Value::String("ggml-org/Qwen3-ASR-0.6B-GGUF".into()),
    );
    object.insert("voiceHoldMs".into(), json!(400));
    object.insert("voiceCleanup".into(), Value::Bool(true));
    object.insert(
        "voiceCleanupEndpoint".into(),
        Value::String("http://127.0.0.1:8081/v1/chat/completions".into()),
    );
    object.insert(
        "voiceCleanupModel".into(),
        Value::String("superwhisper/s1-mini-GGUF".into()),
    );
    object.insert("providers".into(), Value::Array(Vec::new()));
    object.insert("selectedModel".into(), Value::String("fallback".into()));
    object.insert("defaultPermissionMode".into(), Value::String("ask".into()));
    object.insert("favoriteModels".into(), json!(["fallback"]));
    object.insert(
        "routers".into(),
        json!([{"id": "free", "name": "Emma Free Router", "models": [
            "nvidia/nemotron-3-ultra-550b-a55b:free",
            "thinkingmachines/inkling:free",
            "z-ai/glm-5.2:free",
            "poolside/laguna-s-2.1:free",
            "nvidia/nemotron-3-super-120b-a12b:free",
            "thinkingmachines/inkling-small:free",
            "dots-studio/dots-3-note-preview:free",
            "poolside/laguna-xs-2.1:free",
            "cohere/north-mini-code:free",
            "nvidia/nemotron-3.5-lightning:free"
        ]}]),
    );
    object.insert("requireZeroRetention".into(), Value::Bool(false));
    object.insert("accent".into(), Value::String("orange".into()));
    object.insert("navIconColors".into(), Value::Bool(true));
    object.insert("navHues".into(), Value::Object(Map::new()));
    object.insert("folderHues".into(), Value::Object(Map::new()));
    object.insert("uiScale".into(), json!(100));
    object.insert("conversationWidth".into(), Value::String("default".into()));
    object.insert("interfaceFont".into(), Value::String("departure".into()));
    object.insert("agentFont".into(), Value::String("inter".into()));
    object.insert("thinkingLevel".into(), Value::String(String::new()));
    object.insert("keybinds".into(), Value::Object(Map::new()));
    object.insert(
        "contextPages".into(),
        Value::Array(vec![
            page(
                "p1",
                "Context",
                vec![
                    widget("stats", "horizontal"),
                    widget("context", "vertical"),
                    widget("timeline", "vertical"),
                    widget("tasklist", "vertical"),
                    widget("plan", "vertical"),
                    widget("subagents", "vertical"),
                    widget("subthreads", "vertical"),
                ],
            ),
            page(
                "p2",
                "Run",
                vec![
                    widget("timeline", "vertical"),
                    widget("tasklist", "vertical"),
                    widget("plan", "vertical"),
                    widget("subagents", "vertical"),
                    widget("subthreads", "vertical"),
                    widget("git", "vertical"),
                ],
            ),
            page(
                "p3",
                "Machine",
                vec![
                    widget("machinemeters", "vertical"),
                    widget("machinegraph", "vertical"),
                    widget("machine", "horizontal"),
                ],
            ),
        ]),
    );
    Value::Object(object)
}

pub fn migrate_settings(mut value: Value) -> PreferenceResult<Value> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| PreferenceError::InvalidValue {
            key: SETTINGS_KEY.into(),
            message: "expected an object".into(),
        })?;
    if !object.contains_key("providers") {
        if let Some(local_models) = object.remove("localModels") {
            object.insert("providers".into(), local_models);
        }
    } else {
        object.remove("localModels");
    }
    if !object.contains_key("routers") {
        if let Some(models) = object.remove("freeRouterModels") {
            object.insert(
                "routers".into(),
                json!([{ "id": "free", "name": "Emma Free Router", "models": models }]),
            );
        }
    } else {
        object.remove("freeRouterModels");
    }
    let selected = object
        .get("selectedModel")
        .and_then(Value::as_str)
        .map(legacy_model_key);
    if let Some(selected) = selected {
        object.insert("selectedModel".into(), Value::String(selected));
    }
    Ok(value)
}

pub fn legacy_model_key(value: &str) -> String {
    if value == "free-router" {
        "router:free".into()
    } else if let Some(id) = value.strip_prefix("local:") {
        format!("provider:{id}")
    } else {
        value.into()
    }
}

pub fn validate_settings(value: &Value) -> PreferenceResult<()> {
    let Some(object) = value.as_object() else {
        return Err(PreferenceError::InvalidValue {
            key: SETTINGS_KEY.into(),
            message: "expected an object".into(),
        });
    };
    if object.len() > MAX_PREFERENCE_KEYS {
        return Err(PreferenceError::InvalidValue {
            key: SETTINGS_KEY.into(),
            message: format!("contains more than {MAX_PREFERENCE_KEYS} fields"),
        });
    }
    string_field(object, "notchModel", 256)?;
    string_field(object, "selectedModel", 256)?;
    string_field(object, "systemPrompt", 24_576)?;
    string_field(object, "transcriptionEndpoint", 256)?;
    string_field(object, "transcriptionModel", 256)?;
    string_field(object, "voiceCleanupEndpoint", 256)?;
    string_field(object, "voiceCleanupModel", 256)?;
    bool_field(object, "cursorOrbsEnabled")?;
    bool_field(object, "notchCommandsEnabled")?;
    bool_field(object, "transcriptionEnabled")?;
    bool_field(object, "voiceCleanup")?;
    bool_field(object, "requireZeroRetention")?;
    bool_field(object, "navIconColors")?;
    bounded_number(object, "notchGap", 120, 260)?;
    bounded_number(object, "voiceHoldMs", 0, 1_000)?;
    bounded_number(object, "uiScale", 80, 150)?;
    validate_action_list(object.get("quickActions"))?;
    validate_string_list(object.get("cursorOrbs"), "cursorOrbs", 8, 64)?;
    validate_string_list(object.get("favoriteModels"), "favoriteModels", 6, 256)?;
    validate_map(object.get("navHues"), "navHues", 64)?;
    validate_map(object.get("folderHues"), "folderHues", 256)?;
    validate_map(object.get("keybinds"), "keybinds", 7)?;
    validate_context_pages(object.get("contextPages"))?;
    validate_array_limit(object.get("providers"), "providers", 24)?;
    validate_array_limit(object.get("routers"), "routers", 5)?;
    Ok(())
}

fn validate_action_list(value: Option<&Value>) -> PreferenceResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(actions) = value.as_array() else {
        return invalid_settings("quickActions must be an array");
    };
    if actions.len() != 3 {
        return invalid_settings("quickActions must contain exactly three entries");
    }
    for action in actions {
        let Some(action) = action.as_object() else {
            return invalid_settings("quickActions contains an invalid entry");
        };
        for key in ["label", "prompt", "category"] {
            if action.get(key).and_then(Value::as_str).is_none() {
                return invalid_settings("quickActions contains an invalid entry");
            }
        }
        if action
            .get("label")
            .and_then(Value::as_str)
            .is_some_and(|value| value.is_empty() || value.chars().count() > 40)
            || action
                .get("prompt")
                .and_then(Value::as_str)
                .is_some_and(|value| value.is_empty() || value.chars().count() > 4_096)
            || action
                .get("category")
                .and_then(Value::as_str)
                .is_some_and(|value| value.chars().count() > 64)
        {
            return invalid_settings("quickActions contains an entry outside its bounds");
        }
    }
    Ok(())
}

fn validate_string_list(
    value: Option<&Value>,
    key: &str,
    max_items: usize,
    max_chars: usize,
) -> PreferenceResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(items) = value.as_array() else {
        return invalid_settings(format!("{key} must be an array"));
    };
    if items.len() > max_items
        || items.iter().any(|item| {
            item.as_str()
                .is_none_or(|text| text.is_empty() || text.chars().count() > max_chars)
        })
    {
        return invalid_settings(format!("{key} contains an invalid entry"));
    }
    Ok(())
}

fn validate_map(value: Option<&Value>, key: &str, max_items: usize) -> PreferenceResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(map) = value.as_object() else {
        return invalid_settings(format!("{key} must be an object"));
    };
    if map.len() > max_items
        || map
            .keys()
            .any(|key| key.is_empty() || key.chars().count() > 64)
        || map.values().any(|value| {
            value
                .as_str()
                .is_none_or(|text| text.is_empty() || text.chars().count() > 32)
        })
    {
        return invalid_settings(format!("{key} contains an invalid entry"));
    }
    Ok(())
}

fn validate_context_pages(value: Option<&Value>) -> PreferenceResult<()> {
    let Some(value) = value else {
        return Ok(());
    };
    let Some(pages) = value.as_array() else {
        return invalid_settings("contextPages must be an array");
    };
    if pages.is_empty() || pages.len() > 4 {
        return invalid_settings("contextPages is outside its bounds");
    }
    for page in pages {
        let Some(page) = page.as_object() else {
            return invalid_settings("contextPages contains an invalid page");
        };
        if page
            .get("id")
            .and_then(Value::as_str)
            .is_none_or(|id| id.len() != 2 || !id.starts_with('p'))
            || page
                .get("name")
                .and_then(Value::as_str)
                .is_none_or(|name| name.trim().is_empty() || name.chars().count() > 20)
            || page
                .get("widgets")
                .and_then(Value::as_array)
                .is_none_or(|widgets| widgets.len() > 11)
        {
            return invalid_settings("contextPages contains an invalid page");
        }
    }
    Ok(())
}

fn validate_array_limit(
    value: Option<&Value>,
    key: &str,
    max_items: usize,
) -> PreferenceResult<()> {
    if value.is_some_and(|value| value.as_array().is_none_or(|items| items.len() > max_items)) {
        return invalid_settings(format!("{key} is outside its bounds"));
    }
    Ok(())
}

fn string_field(object: &Map<String, Value>, key: &str, max_chars: usize) -> PreferenceResult<()> {
    if object.get(key).is_some_and(|value| {
        value
            .as_str()
            .is_none_or(|text| text.chars().count() > max_chars)
    }) {
        return invalid_settings(format!("{key} is invalid"));
    }
    Ok(())
}

fn bool_field(object: &Map<String, Value>, key: &str) -> PreferenceResult<()> {
    if object.get(key).is_some_and(|value| !value.is_boolean()) {
        return invalid_settings(format!("{key} is invalid"));
    }
    Ok(())
}

fn bounded_number(
    object: &Map<String, Value>,
    key: &str,
    minimum: i64,
    maximum: i64,
) -> PreferenceResult<()> {
    if object.get(key).is_some_and(|value| {
        value
            .as_i64()
            .is_none_or(|number| number < minimum || number > maximum)
    }) {
        return invalid_settings(format!("{key} is invalid"));
    }
    Ok(())
}

fn invalid_settings(message: impl Into<String>) -> PreferenceResult<()> {
    Err(PreferenceError::InvalidValue {
        key: SETTINGS_KEY.into(),
        message: message.into(),
    })
}

fn validate_file_name(name: &str) -> PreferenceResult<()> {
    if name.is_empty()
        || name.len() > MAX_PREFERENCE_KEYS * 8
        || name == "."
        || name == ".."
        || name.contains('/')
        || name.contains('\\')
        || name.chars().any(|character| character.is_control())
    {
        return Err(PreferenceError::InvalidKey(name.into()));
    }
    Ok(())
}

fn validate_scoped_id(id: &str) -> PreferenceResult<()> {
    if id.is_empty()
        || id.chars().count() > MAX_SCOPED_ID_CHARS
        || !id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._:-".contains(&byte))
    {
        return Err(PreferenceError::InvalidKey(id.into()));
    }
    Ok(())
}

fn temporary_path(path: &Path) -> PathBuf {
    let stamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    PathBuf::from(format!(
        "{}.tmp.{}.{}",
        path.display(),
        std::process::id(),
        stamp
    ))
}

fn io_error(operation: &'static str, path: &Path, error: io::Error) -> PreferenceError {
    PreferenceError::Io {
        operation,
        path: path.to_owned(),
        message: error.to_string(),
    }
}

fn set_private_directory(path: &Path) -> PreferenceResult<()> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|error| io_error("protect preference directory", path, error))?;
    }
    Ok(())
}

fn set_private_file(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_root(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "emma-preferences-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    #[test]
    fn keys_keep_electron_wire_names_and_scoped_suffixes() {
        assert_eq!(PreferenceKey::Settings.wire_key(), "emma.settings.v1");
        assert_eq!(PreferenceKey::Layout.wire_key(), "emma.layout.v2");
        assert_eq!(
            scoped_name(ScopedPreference::Draft, "thread-1").unwrap(),
            "emma.threadDraft.v1.thread-1.json"
        );
        assert!(scoped_name(ScopedPreference::Draft, "../thread").is_err());
    }

    #[test]
    fn layout_round_trip_preserves_camel_case_and_validation() {
        let root = temp_root("layout");
        let store = PreferenceStore::new(&root);
        let mut layout = PaneLayout::default();
        layout.nav_order = vec!["research".into(), "knowledge".into()];
        store.write_layout(&layout).unwrap();
        let raw = fs::read_to_string(root.join(PreferenceKey::Layout.file_name())).unwrap();
        assert!(raw.contains("sidebarWidth"));
        assert_eq!(store.read_layout(f64::INFINITY).unwrap(), layout);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_json_is_quarantined_and_defaulted() {
        let root = temp_root("corrupt");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(PreferenceKey::Settings.file_name()), b"not-json").unwrap();
        let store = PreferenceStore::new(&root);
        let settings = store.read_settings_or_default(None).unwrap();
        assert_eq!(settings["selectedModel"], "fallback");
        assert!(fs::read_dir(&root).unwrap().count() >= 1);
        assert!(!root.join(PreferenceKey::Settings.file_name()).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn settings_migrate_legacy_model_and_router_fields() {
        let migrated = migrate_settings(json!({
            "selectedModel": "free-router",
            "freeRouterModels": ["a/b"]
        }))
        .unwrap();
        assert_eq!(migrated["selectedModel"], "router:free");
        assert_eq!(migrated["routers"][0]["id"], "free");
        assert!(validate_settings(&migrated).is_ok());
    }

    #[test]
    fn writes_are_bounded_and_atomic() {
        let root = temp_root("bounded");
        let store = PreferenceStore::with_limit(&root, 32).unwrap();
        let result = store.write(PreferenceKey::Settings, &json!({"text": "x".repeat(33)}));
        assert!(matches!(result, Err(PreferenceError::TooLarge { .. })));
        fs::remove_dir_all(root).ok();
    }
}
