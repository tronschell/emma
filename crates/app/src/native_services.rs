use std::collections::hash_map::DefaultHasher;
use std::env;
use std::ffi::OsString;
use std::fmt::{self, Display, Formatter};
use std::fs;
use std::hash::{Hash, Hasher};
use std::io::{self, Read};
use std::path::{Component, Path, PathBuf};
use std::process::{Child, Command, ExitStatus, Stdio};
use std::sync::{
    Arc,
    atomic::{AtomicBool, Ordering},
};
use std::thread;
use std::time::{Duration, Instant};

pub const MAX_EXTERNAL_URL_CHARS: usize = 2_048;
pub const MAX_DIFF_BYTES: usize = 512 * 1024;
pub const MAX_COMMAND_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_GIT_STATUS_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_COMMIT_PATHS: usize = 500;
pub const MAX_PATH_CHARS: usize = 1_024;
pub const MAX_COMMIT_MESSAGE_BYTES: usize = 4_096;
pub const MAX_GIT_ARGS: usize = 32;
pub const MAX_GIT_ARG_CHARS: usize = 512;
pub const MAX_HISTORY: usize = 200;
pub const DEFAULT_HISTORY: usize = 60;
pub const MAX_UNTRACKED: usize = 20;
pub const MAX_BRANCHES: usize = 200;
pub const MAX_WORKTREES: usize = 32;
pub const ACTION_TIMEOUT: Duration = Duration::from_secs(10);
pub const GIT_TIMEOUT: Duration = Duration::from_secs(10);
pub const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(120);
pub const DIALOG_TIMEOUT: Duration = Duration::from_secs(300);

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeServiceError {
    InvalidInput {
        field: &'static str,
        message: String,
    },
    UnsupportedPlatform {
        capability: &'static str,
    },
    Io {
        operation: &'static str,
        message: String,
    },
    Process {
        program: String,
        code: Option<i32>,
        output: String,
    },
    ExecutableMissing {
        program: String,
    },
    TimedOut {
        program: String,
    },
    Cancelled,
    NotFound {
        capability: &'static str,
    },
    OutsideRoot {
        path: PathBuf,
    },
    NotRepository {
        path: PathBuf,
    },
}

impl Display for NativeServiceError {
    fn fmt(&self, formatter: &mut Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidInput { field, message } => write!(formatter, "{field}: {message}"),
            Self::UnsupportedPlatform { capability } => {
                write!(formatter, "{capability} is unavailable on this platform")
            }
            Self::Io { operation, message } => write!(formatter, "{operation}: {message}"),
            Self::Process {
                program,
                code,
                output,
            } => {
                if let Some(code) = code {
                    write!(formatter, "{program} exited with {code}: {output}")
                } else {
                    write!(formatter, "{program} failed: {output}")
                }
            }
            Self::ExecutableMissing { program } => write!(formatter, "{program} is not installed"),
            Self::TimedOut { program } => write!(formatter, "{program} timed out"),
            Self::Cancelled => formatter.write_str("the native operation was cancelled"),
            Self::NotFound { capability } => write!(formatter, "{capability} was not found"),
            Self::OutsideRoot { path } => write!(
                formatter,
                "path is outside its granted root: {}",
                path.display()
            ),
            Self::NotRepository { path } => {
                write!(formatter, "not a Git repository: {}", path.display())
            }
        }
    }
}

impl std::error::Error for NativeServiceError {}

pub type NativeResult<T> = Result<T, NativeServiceError>;

#[derive(Clone, Default)]
pub struct NativeCancellation(Arc<AtomicBool>);

impl NativeCancellation {
    pub fn cancel(&self) {
        self.0.store(true, Ordering::Release);
    }

    pub fn is_cancelled(&self) -> bool {
        self.0.load(Ordering::Acquire)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedRoot {
    path: PathBuf,
}

impl ValidatedRoot {
    pub fn open(path: &Path) -> NativeResult<Self> {
        let path = canonical_directory(path)?;
        Ok(Self { path })
    }

    pub fn path(&self) -> &Path {
        &self.path
    }

    pub fn resolve(&self, relative: &str) -> NativeResult<PathBuf> {
        validate_relative_path(relative, "path")?;
        let candidate = self.path.join(relative);
        ensure_lexical_inside(&self.path, &candidate)?;
        ensure_real_parent_inside(&self.path, &candidate)?;
        Ok(candidate)
    }

    pub fn contains(&self, path: &Path) -> NativeResult<PathBuf> {
        let path = canonical_existing(path)?;
        if !path_inside(&self.path, &path) {
            return Err(NativeServiceError::OutsideRoot { path });
        }
        Ok(path)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ValidatedRepository {
    root: PathBuf,
    common_dir: PathBuf,
}

impl ValidatedRepository {
    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn common_dir(&self) -> &Path {
        &self.common_dir
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectFolder {
    pub id: String,
    pub path: PathBuf,
    pub name: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FolderPickerRequest {
    pub prompt: String,
    pub default_path: Option<PathBuf>,
}

impl Default for FolderPickerRequest {
    fn default() -> Self {
        Self {
            prompt: String::from("Choose a folder"),
            default_path: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FilePickerRequest {
    pub prompt: String,
    pub default_path: Option<PathBuf>,
    pub multiple: bool,
}

impl Default for FilePickerRequest {
    fn default() -> Self {
        Self {
            prompt: String::from("Choose a file"),
            default_path: None,
            multiple: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum EditorId {
    Vscode,
    VscodeInsiders,
    Cursor,
    Windsurf,
    Zed,
    Antigravity,
    Trae,
    Kiro,
    Void,
    Positron,
    Sublime,
    Atom,
    Nova,
    Bbedit,
    Textmate,
    Emacs,
    Webstorm,
    Intellij,
    IntellijCe,
    Pycharm,
    PycharmCe,
    Goland,
    Rustrover,
    Clion,
    Phpstorm,
    Rubymine,
    Rider,
    Datagrip,
    Fleet,
    Eclipse,
    AndroidStudio,
    Xcode,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EditorSpec {
    pub id: EditorId,
    pub key: &'static str,
    pub label: &'static str,
    pub bundle: &'static str,
}

pub const EDITORS: [EditorSpec; 32] = [
    EditorSpec {
        id: EditorId::Vscode,
        key: "vscode",
        label: "Visual Studio Code",
        bundle: "Visual Studio Code",
    },
    EditorSpec {
        id: EditorId::VscodeInsiders,
        key: "vscode-insiders",
        label: "Visual Studio Code - Insiders",
        bundle: "Visual Studio Code - Insiders",
    },
    EditorSpec {
        id: EditorId::Cursor,
        key: "cursor",
        label: "Cursor",
        bundle: "Cursor",
    },
    EditorSpec {
        id: EditorId::Windsurf,
        key: "windsurf",
        label: "Windsurf",
        bundle: "Windsurf",
    },
    EditorSpec {
        id: EditorId::Zed,
        key: "zed",
        label: "Zed",
        bundle: "Zed",
    },
    EditorSpec {
        id: EditorId::Antigravity,
        key: "antigravity",
        label: "Antigravity",
        bundle: "Antigravity",
    },
    EditorSpec {
        id: EditorId::Trae,
        key: "trae",
        label: "Trae",
        bundle: "Trae",
    },
    EditorSpec {
        id: EditorId::Kiro,
        key: "kiro",
        label: "Kiro",
        bundle: "Kiro",
    },
    EditorSpec {
        id: EditorId::Void,
        key: "void",
        label: "Void",
        bundle: "Void",
    },
    EditorSpec {
        id: EditorId::Positron,
        key: "positron",
        label: "Positron",
        bundle: "Positron",
    },
    EditorSpec {
        id: EditorId::Sublime,
        key: "sublime",
        label: "Sublime Text",
        bundle: "Sublime Text",
    },
    EditorSpec {
        id: EditorId::Atom,
        key: "atom",
        label: "Atom",
        bundle: "Atom",
    },
    EditorSpec {
        id: EditorId::Nova,
        key: "nova",
        label: "Nova",
        bundle: "Nova",
    },
    EditorSpec {
        id: EditorId::Bbedit,
        key: "bbedit",
        label: "BBEdit",
        bundle: "BBEdit",
    },
    EditorSpec {
        id: EditorId::Textmate,
        key: "textmate",
        label: "TextMate",
        bundle: "TextMate",
    },
    EditorSpec {
        id: EditorId::Emacs,
        key: "emacs",
        label: "Emacs",
        bundle: "Emacs",
    },
    EditorSpec {
        id: EditorId::Webstorm,
        key: "webstorm",
        label: "WebStorm",
        bundle: "WebStorm",
    },
    EditorSpec {
        id: EditorId::Intellij,
        key: "intellij",
        label: "IntelliJ IDEA",
        bundle: "IntelliJ IDEA",
    },
    EditorSpec {
        id: EditorId::IntellijCe,
        key: "intellij-ce",
        label: "IntelliJ IDEA CE",
        bundle: "IntelliJ IDEA CE",
    },
    EditorSpec {
        id: EditorId::Pycharm,
        key: "pycharm",
        label: "PyCharm",
        bundle: "PyCharm",
    },
    EditorSpec {
        id: EditorId::PycharmCe,
        key: "pycharm-ce",
        label: "PyCharm CE",
        bundle: "PyCharm CE",
    },
    EditorSpec {
        id: EditorId::Goland,
        key: "goland",
        label: "GoLand",
        bundle: "GoLand",
    },
    EditorSpec {
        id: EditorId::Rustrover,
        key: "rustrover",
        label: "RustRover",
        bundle: "RustRover",
    },
    EditorSpec {
        id: EditorId::Clion,
        key: "clion",
        label: "CLion",
        bundle: "CLion",
    },
    EditorSpec {
        id: EditorId::Phpstorm,
        key: "phpstorm",
        label: "PhpStorm",
        bundle: "PhpStorm",
    },
    EditorSpec {
        id: EditorId::Rubymine,
        key: "rubymine",
        label: "RubyMine",
        bundle: "RubyMine",
    },
    EditorSpec {
        id: EditorId::Rider,
        key: "rider",
        label: "Rider",
        bundle: "Rider",
    },
    EditorSpec {
        id: EditorId::Datagrip,
        key: "datagrip",
        label: "DataGrip",
        bundle: "DataGrip",
    },
    EditorSpec {
        id: EditorId::Fleet,
        key: "fleet",
        label: "Fleet",
        bundle: "Fleet",
    },
    EditorSpec {
        id: EditorId::Eclipse,
        key: "eclipse",
        label: "Eclipse",
        bundle: "Eclipse",
    },
    EditorSpec {
        id: EditorId::AndroidStudio,
        key: "android-studio",
        label: "Android Studio",
        bundle: "Android Studio",
    },
    EditorSpec {
        id: EditorId::Xcode,
        key: "xcode",
        label: "Xcode",
        bundle: "Xcode",
    },
];

impl EditorId {
    pub fn parse(value: &str) -> NativeResult<Self> {
        EDITORS
            .iter()
            .find(|spec| spec.key == value)
            .map(|spec| spec.id)
            .ok_or_else(|| invalid("editor", "unknown editor"))
    }

    pub fn key(self) -> &'static str {
        editor_spec(self).key
    }

    pub fn label(self) -> &'static str {
        editor_spec(self).label
    }

    pub fn bundle(self) -> &'static str {
        editor_spec(self).bundle
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum GitReadyStatus {
    Ready,
    NoGit,
    NoRepository,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitFileEntry {
    pub path: String,
    pub index: char,
    pub work: char,
    pub from: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitSnapshot {
    pub branch: String,
    pub head: String,
    pub upstream: String,
    pub ahead: u32,
    pub behind: u32,
    pub worktree: bool,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
    pub files: Vec<GitFileEntry>,
    pub diff: String,
    pub truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommit {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub when: i64,
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitHistory {
    pub commits: Vec<GitCommit>,
    pub more: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommandResult {
    pub ok: bool,
    pub output: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct WorktreeEntry {
    pub path: PathBuf,
    pub head: String,
    pub branch: String,
    pub primary: bool,
    pub bare: bool,
    pub detached: bool,
    pub locked: bool,
    pub prunable: bool,
    pub dirty: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum GitRequest {
    Ready {
        path: PathBuf,
    },
    Initialize {
        path: PathBuf,
    },
    Status {
        repository: ValidatedRepository,
        include_diff: bool,
    },
    Diff {
        repository: ValidatedRepository,
        paths: Vec<String>,
    },
    History {
        repository: ValidatedRepository,
        skip: usize,
        limit: usize,
    },
    Stage {
        repository: ValidatedRepository,
        paths: Vec<String>,
    },
    Unstage {
        repository: ValidatedRepository,
        paths: Vec<String>,
    },
    Commit {
        repository: ValidatedRepository,
        message: String,
        paths: Vec<String>,
        amend: bool,
    },
    Discard {
        repository: ValidatedRepository,
        paths: Vec<String>,
    },
    SwitchBranch {
        repository: ValidatedRepository,
        branch: String,
        create: bool,
        from: Option<String>,
    },
    Branches {
        repository: ValidatedRepository,
    },
    ListWorktrees {
        repository: ValidatedRepository,
    },
    CreateWorktree {
        repository: ValidatedRepository,
        name: String,
        from: Option<String>,
    },
    RemoveWorktrees {
        repository: ValidatedRepository,
        paths: Vec<PathBuf>,
    },
    ReadOnlyCommand {
        repository: ValidatedRepository,
        args: Vec<String>,
    },
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum GitResult {
    Ready(GitReadyStatus),
    Unit,
    Snapshot(GitSnapshot),
    Diff { output: String, truncated: bool },
    History(GitHistory),
    Commit { hash: String },
    Branches(Vec<String>),
    Worktrees(Vec<WorktreeEntry>),
    Command(GitCommandResult),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum NativeRequest {
    OpenPath {
        path: PathBuf,
    },
    RevealPath {
        path: PathBuf,
    },
    OpenUrl {
        url: String,
    },
    OpenEditor {
        editor: EditorId,
        path: PathBuf,
        root: Option<ValidatedRoot>,
    },
    ChooseFolder(FolderPickerRequest),
    ChooseFiles(FilePickerRequest),
    ConnectFolder {
        path: PathBuf,
        id: Option<String>,
    },
    Git(GitRequest),
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum NativeResponse {
    Opened,
    Revealed,
    UrlOpened,
    EditorOpened,
    Folder(Option<PathBuf>),
    Files(Vec<PathBuf>),
    Connected(ProjectFolder),
    Git(GitResult),
}

#[derive(Clone, Debug)]
pub struct NativeServices {
    action_timeout: Duration,
    git_timeout: Duration,
    git_command_timeout: Duration,
    #[cfg(target_os = "macos")]
    dialog_timeout: Duration,
}

impl Default for NativeServices {
    fn default() -> Self {
        Self {
            action_timeout: ACTION_TIMEOUT,
            git_timeout: GIT_TIMEOUT,
            git_command_timeout: GIT_COMMAND_TIMEOUT,
            #[cfg(target_os = "macos")]
            dialog_timeout: DIALOG_TIMEOUT,
        }
    }
}

impl NativeServices {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn validate_root(&self, path: &Path) -> NativeResult<ValidatedRoot> {
        ValidatedRoot::open(path)
    }

    pub fn validate_repository(&self, path: &Path) -> NativeResult<ValidatedRepository> {
        let requested = canonical_directory(path)?;
        let top_output = match self.git_checked(
            &requested,
            &["rev-parse", "--show-toplevel"],
            self.git_timeout,
        ) {
            Ok(output) => output,
            Err(NativeServiceError::Process { .. }) => {
                return Err(NativeServiceError::NotRepository { path: requested });
            }
            Err(error) => return Err(error),
        };
        let top = path_from_git_output(&requested, &top_output)?;
        let root = canonical_directory(&top)?;
        let common_output = match self.git_checked(
            &root,
            &["rev-parse", "--path-format=absolute", "--git-common-dir"],
            self.git_timeout,
        ) {
            Ok(output) => output,
            Err(NativeServiceError::Process { .. }) => {
                return Err(NativeServiceError::NotRepository { path: root });
            }
            Err(error) => return Err(error),
        };
        let common_dir = canonical_directory(&path_from_git_output(&root, &common_output)?)?;
        Ok(ValidatedRepository { root, common_dir })
    }

    pub fn connect_folder(&self, path: &Path, id: Option<&str>) -> NativeResult<ProjectFolder> {
        let path = canonical_directory(path)?;
        let id = match id {
            Some(value) => validate_identifier(value, "folder id")?.to_owned(),
            None => stable_folder_id(&path),
        };
        let name = path
            .file_name()
            .and_then(|value| value.to_str())
            .filter(|value| !value.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(|| path.display().to_string());
        Ok(ProjectFolder { id, path, name })
    }

    pub fn installed_editors(&self) -> Vec<EditorSpec> {
        EDITORS
            .iter()
            .copied()
            .filter(|spec| editor_installed(*spec))
            .collect()
    }

    pub fn execute(&self, request: NativeRequest) -> NativeResult<NativeResponse> {
        self.execute_cancellable(request, &NativeCancellation::default())
    }

    pub fn execute_cancellable(
        &self,
        request: NativeRequest,
        cancellation: &NativeCancellation,
    ) -> NativeResult<NativeResponse> {
        match request {
            NativeRequest::OpenPath { path } => {
                self.open_path(&path, cancellation)?;
                Ok(NativeResponse::Opened)
            }
            NativeRequest::RevealPath { path } => {
                self.reveal_path(&path, cancellation)?;
                Ok(NativeResponse::Revealed)
            }
            NativeRequest::OpenUrl { url } => {
                self.open_url(&url, cancellation)?;
                Ok(NativeResponse::UrlOpened)
            }
            NativeRequest::OpenEditor { editor, path, root } => {
                self.open_editor(editor, &path, root.as_ref(), cancellation)?;
                Ok(NativeResponse::EditorOpened)
            }
            NativeRequest::ChooseFolder(request) => Ok(NativeResponse::Folder(
                self.choose_folder(&request, cancellation)?,
            )),
            NativeRequest::ChooseFiles(request) => Ok(NativeResponse::Files(
                self.choose_files(&request, cancellation)?,
            )),
            NativeRequest::ConnectFolder { path, id } => Ok(NativeResponse::Connected(
                self.connect_folder(&path, id.as_deref())?,
            )),
            NativeRequest::Git(request) => Ok(NativeResponse::Git(
                self.execute_git(request, cancellation)?,
            )),
        }
    }

    pub fn open_path(&self, path: &Path, cancellation: &NativeCancellation) -> NativeResult<()> {
        let path = canonical_existing(path)?;
        let args = vec![path.as_os_str().to_os_string()];
        self.run_opener(&args, cancellation)
    }

    pub fn reveal_path(&self, path: &Path, cancellation: &NativeCancellation) -> NativeResult<()> {
        let path = canonical_existing(path)?;
        #[cfg(target_os = "macos")]
        let args = vec![OsString::from("-R"), path.as_os_str().to_os_string()];
        #[cfg(target_os = "windows")]
        let args = vec![OsString::from(format!("/select,{}", path.display()))];
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let args = vec![path.parent().unwrap_or(&path).as_os_str().to_os_string()];
        self.run_revealer(&args, cancellation)
    }

    pub fn open_url(&self, value: &str, cancellation: &NativeCancellation) -> NativeResult<()> {
        validate_external_url(value)?;
        let args = vec![OsString::from(value)];
        self.run_browser(&args, cancellation)
    }

    pub fn open_editor(
        &self,
        editor: EditorId,
        path: &Path,
        root: Option<&ValidatedRoot>,
        cancellation: &NativeCancellation,
    ) -> NativeResult<()> {
        let path = canonical_existing(path)?;
        if let Some(root) = root {
            root.contains(&path)?;
        }
        #[cfg(target_os = "macos")]
        {
            let bundle = mac_editor_bundle(editor)?;
            let args = vec![
                OsString::from("-a"),
                bundle.into_os_string(),
                path.into_os_string(),
            ];
            let output = self.run_program(
                "open",
                &args,
                None,
                self.action_timeout,
                MAX_COMMAND_OUTPUT_BYTES,
                cancellation,
                false,
            )?;
            ensure_process_success("open", &output)?;
            return Ok(());
        }
        #[cfg(target_os = "windows")]
        {
            let command =
                windows_editor_command(editor).ok_or(NativeServiceError::UnsupportedPlatform {
                    capability: "configured editor",
                })?;
            let args = vec![path.into_os_string()];
            let output = self.run_program(
                command,
                &args,
                None,
                self.action_timeout,
                MAX_COMMAND_OUTPUT_BYTES,
                cancellation,
                false,
            )?;
            ensure_process_success(command, &output)?;
            return Ok(());
        }
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        {
            let _ = editor;
            let _ = path;
            let _ = cancellation;
            Err(NativeServiceError::UnsupportedPlatform {
                capability: "configured editor",
            })
        }
    }

    pub fn choose_folder(
        &self,
        request: &FolderPickerRequest,
        cancellation: &NativeCancellation,
    ) -> NativeResult<Option<PathBuf>> {
        validate_prompt(&request.prompt)?;
        let default = validate_dialog_default(request.default_path.as_deref(), true)?;
        #[cfg(target_os = "macos")]
        {
            let script = folder_picker_script(&request.prompt, default.as_deref());
            let output = self.run_program(
                "/usr/bin/osascript",
                &[OsString::from("-e"), OsString::from(script)],
                None,
                self.dialog_timeout,
                MAX_COMMAND_OUTPUT_BYTES,
                cancellation,
                true,
            );
            return match output {
                Ok(output) => {
                    ensure_process_success("osascript", &output)?;
                    Ok(parse_picker_output(&output.stdout).into_iter().next())
                }
                Err(error) if picker_cancelled(&error) => Ok(None),
                Err(error) => Err(error),
            };
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = default;
            let _ = cancellation;
            Err(NativeServiceError::UnsupportedPlatform {
                capability: "folder picker",
            })
        }
    }

    pub fn choose_files(
        &self,
        request: &FilePickerRequest,
        cancellation: &NativeCancellation,
    ) -> NativeResult<Vec<PathBuf>> {
        validate_prompt(&request.prompt)?;
        let default = validate_dialog_default(request.default_path.as_deref(), false)?;
        #[cfg(target_os = "macos")]
        {
            let script = file_picker_script(&request.prompt, default.as_deref(), request.multiple);
            let output = self.run_program(
                "/usr/bin/osascript",
                &[OsString::from("-e"), OsString::from(script)],
                None,
                self.dialog_timeout,
                MAX_COMMAND_OUTPUT_BYTES,
                cancellation,
                true,
            );
            return match output {
                Ok(output) => {
                    ensure_process_success("osascript", &output)?;
                    Ok(parse_picker_output(&output.stdout))
                }
                Err(error) if picker_cancelled(&error) => Ok(Vec::new()),
                Err(error) => Err(error),
            };
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = default;
            let _ = cancellation;
            Err(NativeServiceError::UnsupportedPlatform {
                capability: "file picker",
            })
        }
    }

    fn execute_git(
        &self,
        request: GitRequest,
        cancellation: &NativeCancellation,
    ) -> NativeResult<GitResult> {
        match request {
            GitRequest::Ready { path } => {
                Ok(GitResult::Ready(self.git_ready(&path, cancellation)?))
            }
            GitRequest::Initialize { path } => {
                let root = canonical_directory(&path)?;
                self.git_checked_cancelled(
                    &root,
                    &[String::from("init")],
                    self.git_timeout,
                    cancellation,
                )?;
                Ok(GitResult::Unit)
            }
            GitRequest::Status {
                repository,
                include_diff,
            } => Ok(GitResult::Snapshot(self.git_snapshot(
                &repository,
                include_diff,
                cancellation,
            )?)),
            GitRequest::Diff { repository, paths } => {
                let paths = validate_repo_paths(&repository, &paths)?;
                let mut args = vec![
                    "diff".to_owned(),
                    "--no-color".to_owned(),
                    "--no-ext-diff".to_owned(),
                    "HEAD".to_owned(),
                ];
                if !paths.is_empty() {
                    args.push("--".to_owned());
                    args.extend(paths);
                }
                let output = self.git_diff_output(&repository, &args, cancellation)?;
                Ok(GitResult::Diff {
                    output: output.text,
                    truncated: output.truncated,
                })
            }
            GitRequest::History {
                repository,
                skip,
                limit,
            } => Ok(GitResult::History(self.git_history(
                &repository,
                skip,
                limit,
                cancellation,
            )?)),
            GitRequest::Stage { repository, paths } => {
                let paths = validate_repo_paths(&repository, &paths)?;
                require_paths(&paths)?;
                let mut args = vec!["add".to_owned(), "--".to_owned()];
                args.extend(paths);
                self.git_checked_cancelled(
                    &repository.root,
                    &args,
                    self.git_timeout,
                    cancellation,
                )?;
                Ok(GitResult::Unit)
            }
            GitRequest::Unstage { repository, paths } => {
                let paths = validate_repo_paths(&repository, &paths)?;
                require_paths(&paths)?;
                let mut args = vec!["restore".to_owned(), "--staged".to_owned(), "--".to_owned()];
                args.extend(paths);
                self.git_checked_cancelled(
                    &repository.root,
                    &args,
                    self.git_timeout,
                    cancellation,
                )?;
                Ok(GitResult::Unit)
            }
            GitRequest::Commit {
                repository,
                message,
                paths,
                amend,
            } => Ok(GitResult::Commit {
                hash: self.git_commit(&repository, &message, &paths, amend, cancellation)?,
            }),
            GitRequest::Discard { repository, paths } => {
                self.git_discard(&repository, &paths, cancellation)?;
                Ok(GitResult::Unit)
            }
            GitRequest::SwitchBranch {
                repository,
                branch,
                create,
                from,
            } => {
                validate_branch(&branch, "branch")?;
                if let Some(from) = from.as_deref() {
                    validate_branch(from, "from")?;
                }
                let check = vec![
                    String::from("check-ref-format"),
                    String::from("--branch"),
                    branch.clone(),
                ];
                self.git_checked_cancelled(
                    &repository.root,
                    &check,
                    self.git_timeout,
                    cancellation,
                )?;
                let mut args = vec!["switch".to_owned()];
                if create {
                    args.push("-c".to_owned());
                }
                args.push(branch);
                if let Some(from) = from {
                    if !create {
                        return Err(invalid(
                            "from",
                            "a starting branch is only valid when creating a branch",
                        ));
                    }
                    let verify = ["rev-parse", "--verify", "--quiet"];
                    let ref_name = format!("refs/heads/{from}");
                    let mut verify_args = verify
                        .iter()
                        .map(|item| (*item).to_owned())
                        .collect::<Vec<_>>();
                    verify_args.push(ref_name);
                    self.git_checked_cancelled(
                        &repository.root,
                        &verify_args,
                        self.git_timeout,
                        cancellation,
                    )?;
                    args.push(from);
                }
                self.git_checked_cancelled(
                    &repository.root,
                    &args,
                    self.git_timeout,
                    cancellation,
                )?;
                Ok(GitResult::Unit)
            }
            GitRequest::Branches { repository } => Ok(GitResult::Branches(
                self.git_branches(&repository, cancellation)?,
            )),
            GitRequest::ListWorktrees { repository } => Ok(GitResult::Worktrees(
                self.git_worktrees(&repository, cancellation)?,
            )),
            GitRequest::CreateWorktree {
                repository,
                name,
                from,
            } => Ok(GitResult::Worktrees(vec![self.git_create_worktree(
                &repository,
                &name,
                from.as_deref(),
                cancellation,
            )?])),
            GitRequest::RemoveWorktrees { repository, paths } => {
                self.git_remove_worktrees(&repository, &paths, cancellation)?;
                Ok(GitResult::Unit)
            }
            GitRequest::ReadOnlyCommand { repository, args } => {
                let args = validate_read_only_git_args(&args)?;
                let output = self.git_raw(
                    &repository.root,
                    &args,
                    self.git_command_timeout,
                    MAX_COMMAND_OUTPUT_BYTES,
                    cancellation,
                )?;
                let text = process_text(&output);
                Ok(GitResult::Command(GitCommandResult {
                    ok: output.status.success(),
                    output: text,
                }))
            }
        }
    }

    fn git_ready(
        &self,
        path: &Path,
        cancellation: &NativeCancellation,
    ) -> NativeResult<GitReadyStatus> {
        let path = match canonical_directory(path) {
            Ok(path) => path,
            Err(NativeServiceError::NotFound { .. })
            | Err(NativeServiceError::InvalidInput { .. }) => {
                return Ok(GitReadyStatus::NoRepository);
            }
            Err(error) => return Err(error),
        };
        match self.git_raw(
            &path,
            &["rev-parse".to_owned(), "--is-inside-work-tree".to_owned()],
            self.git_timeout,
            MAX_COMMAND_OUTPUT_BYTES,
            cancellation,
        ) {
            Ok(output) if output.status.success() => Ok(GitReadyStatus::Ready),
            Err(NativeServiceError::ExecutableMissing { .. }) => Ok(GitReadyStatus::NoGit),
            Err(NativeServiceError::Cancelled) => Err(NativeServiceError::Cancelled),
            Err(NativeServiceError::TimedOut { program }) => {
                Err(NativeServiceError::TimedOut { program })
            }
            _ => Ok(GitReadyStatus::NoRepository),
        }
    }

    fn git_snapshot(
        &self,
        repository: &ValidatedRepository,
        include_diff: bool,
        cancellation: &NativeCancellation,
    ) -> NativeResult<GitSnapshot> {
        let status = self.git_raw(
            &repository.root,
            &[
                "-c".to_owned(),
                "core.quotepath=false".to_owned(),
                "status".to_owned(),
                "--porcelain=v1".to_owned(),
                "-b".to_owned(),
                "-z".to_owned(),
            ],
            self.git_timeout,
            MAX_GIT_STATUS_BYTES,
            cancellation,
        )?;
        ensure_process_success("git", &status)?;
        let (branch, upstream, ahead, behind, files) = parse_status_z(&status.stdout);
        let head = self
            .git_raw(
                &repository.root,
                &[
                    "rev-parse".to_owned(),
                    "--short".to_owned(),
                    "HEAD".to_owned(),
                ],
                self.git_timeout,
                MAX_COMMAND_OUTPUT_BYTES,
                cancellation,
            )
            .ok()
            .map(|output| output.stdout.trim().to_owned())
            .unwrap_or_default();
        let diff = if include_diff {
            self.git_snapshot_diff(repository, &files, cancellation)?
        } else {
            DiffOutput {
                text: String::new(),
                truncated: false,
            }
        };
        let branches = self.git_branches(repository, cancellation)?;
        let remotes = self.git_lines(
            repository,
            &["remote"],
            cancellation,
            MAX_COMMAND_OUTPUT_BYTES,
        )?;
        Ok(GitSnapshot {
            branch,
            head,
            upstream,
            ahead,
            behind,
            worktree: repository.root != repository.common_dir,
            branches,
            remotes,
            files,
            diff: diff.text,
            truncated: diff.truncated,
        })
    }

    fn git_snapshot_diff(
        &self,
        repository: &ValidatedRepository,
        files: &[GitFileEntry],
        cancellation: &NativeCancellation,
    ) -> NativeResult<DiffOutput> {
        let tracked = self.git_raw(
            &repository.root,
            &[
                "diff".to_owned(),
                "--no-color".to_owned(),
                "--no-ext-diff".to_owned(),
                "HEAD".to_owned(),
            ],
            self.git_timeout,
            MAX_GIT_STATUS_BYTES,
            cancellation,
        )?;
        let tracked = if tracked.status.success() {
            tracked
        } else {
            self.git_raw(
                &repository.root,
                &[
                    "diff".to_owned(),
                    "--no-color".to_owned(),
                    "--no-ext-diff".to_owned(),
                ],
                self.git_timeout,
                MAX_GIT_STATUS_BYTES,
                cancellation,
            )?
        };
        let mut text = String::new();
        let mut truncated = tracked.truncated;
        truncated |= append_diff(&mut text, &tracked.stdout);
        let untracked = files
            .iter()
            .filter(|entry| entry.index == '?' || entry.work == '?')
            .take(MAX_UNTRACKED);
        for entry in untracked {
            validate_repo_path(repository, &entry.path)?;
            let args = vec![
                "diff".to_owned(),
                "--no-color".to_owned(),
                "--no-ext-diff".to_owned(),
                "--no-index".to_owned(),
                "--".to_owned(),
                null_device().to_owned(),
                entry.path.clone(),
            ];
            let output = self.git_raw(
                &repository.root,
                &args,
                self.git_timeout,
                MAX_GIT_STATUS_BYTES,
                cancellation,
            )?;
            if output.status.success() || output.status.code() == Some(1) {
                truncated |= output.truncated;
                truncated |= append_diff(&mut text, &output.stdout);
            }
        }
        Ok(DiffOutput { text, truncated })
    }

    fn git_history(
        &self,
        repository: &ValidatedRepository,
        skip: usize,
        limit: usize,
        cancellation: &NativeCancellation,
    ) -> NativeResult<GitHistory> {
        let take = limit.clamp(1, MAX_HISTORY);
        let from = skip.min(usize::MAX.saturating_sub(take));
        let args = vec![
            "log".to_owned(),
            "--branches".to_owned(),
            "HEAD".to_owned(),
            "--date-order".to_owned(),
            "--format=%H%x01%P%x01%ct%x01%an%x01%D%x01%s%x00".to_owned(),
            format!("--skip={from}"),
            format!("--max-count={}", take + 1),
        ];
        let output = self.git_raw(
            &repository.root,
            &args,
            self.git_timeout,
            MAX_GIT_STATUS_BYTES,
            cancellation,
        )?;
        if !output.status.success() {
            return Ok(GitHistory {
                commits: Vec::new(),
                more: false,
            });
        }
        let mut commits = parse_history(&output.stdout);
        let more = commits.len() > take;
        commits.truncate(take);
        Ok(GitHistory { commits, more })
    }

    fn git_commit(
        &self,
        repository: &ValidatedRepository,
        message: &str,
        paths: &[String],
        amend: bool,
        cancellation: &NativeCancellation,
    ) -> NativeResult<String> {
        let paths = validate_repo_paths(repository, paths)?;
        if message.len() > MAX_COMMIT_MESSAGE_BYTES {
            return Err(invalid("message", "commit message is too long"));
        }
        let message = message.trim().to_owned();
        if paths.is_empty() && !amend {
            return Err(invalid("paths", "pick at least one file to commit"));
        }
        if message.is_empty() && !amend {
            return Err(invalid("message", "write a commit message first"));
        }
        if !paths.is_empty() {
            let mut args = vec![
                "-c".to_owned(),
                "core.quotepath=false".to_owned(),
                "status".to_owned(),
                "--porcelain=v1".to_owned(),
                "-z".to_owned(),
                "--".to_owned(),
            ];
            args.extend(paths.clone());
            let output = self.git_checked_cancelled(
                repository.root(),
                &args,
                self.git_timeout,
                cancellation,
            )?;
            let pending = parse_status_z(&output)
                .4
                .into_iter()
                .filter(|entry| entry.work != ' ')
                .map(|entry| entry.path)
                .collect::<Vec<_>>();
            if !pending.is_empty() {
                let mut add = vec!["add".to_owned(), "-A".to_owned(), "--".to_owned()];
                add.extend(pending);
                self.git_checked_cancelled(
                    repository.root(),
                    &add,
                    self.git_timeout,
                    cancellation,
                )?;
            }
        }
        let mut args = vec!["commit".to_owned()];
        if amend {
            args.push("--amend".to_owned());
        }
        if message.is_empty() {
            args.push("--no-edit".to_owned());
        } else {
            args.push("-m".to_owned());
            args.push(message);
        }
        if !paths.is_empty() {
            args.push("--".to_owned());
            args.extend(paths);
        }
        self.git_checked_cancelled(repository.root(), &args, self.git_timeout, cancellation)?;
        let output = self.git_checked_cancelled(
            repository.root(),
            &[
                "rev-parse".to_owned(),
                "--short".to_owned(),
                "HEAD".to_owned(),
            ],
            self.git_timeout,
            cancellation,
        )?;
        Ok(output.trim().to_owned())
    }

    fn git_discard(
        &self,
        repository: &ValidatedRepository,
        paths: &[String],
        cancellation: &NativeCancellation,
    ) -> NativeResult<()> {
        let paths = validate_repo_paths(repository, paths)?;
        require_paths(&paths)?;
        let mut list = vec!["ls-files".to_owned(), "-z".to_owned(), "--".to_owned()];
        list.extend(paths.clone());
        let known =
            self.git_checked_cancelled(repository.root(), &list, self.git_timeout, cancellation)?;
        let known = known
            .split('\0')
            .filter(|value| !value.is_empty())
            .collect::<Vec<_>>();
        let tracked = paths
            .iter()
            .filter(|path| {
                known
                    .iter()
                    .any(|entry| *entry == *path || entry.starts_with(&format!("{path}/")))
            })
            .cloned()
            .collect::<Vec<_>>();
        let loose = paths
            .iter()
            .filter(|path| !tracked.iter().any(|entry| entry == *path))
            .cloned()
            .collect::<Vec<_>>();
        if !tracked.is_empty() {
            let mut args = vec![
                "restore".to_owned(),
                "--staged".to_owned(),
                "--worktree".to_owned(),
                "--".to_owned(),
            ];
            args.extend(tracked);
            self.git_checked_cancelled(repository.root(), &args, self.git_timeout, cancellation)?;
        }
        if !loose.is_empty() {
            let mut args = vec![
                "clean".to_owned(),
                "-f".to_owned(),
                "-d".to_owned(),
                "--".to_owned(),
            ];
            args.extend(loose);
            self.git_checked_cancelled(repository.root(), &args, self.git_timeout, cancellation)?;
        }
        Ok(())
    }

    fn git_branches(
        &self,
        repository: &ValidatedRepository,
        cancellation: &NativeCancellation,
    ) -> NativeResult<Vec<String>> {
        self.git_lines(
            repository,
            &[
                "for-each-ref",
                "--sort=-committerdate",
                "--format=%(refname:short)",
                "refs/heads",
            ],
            cancellation,
            MAX_COMMAND_OUTPUT_BYTES,
        )
        .map(|mut branches| {
            branches.truncate(MAX_BRANCHES);
            branches
        })
    }

    fn git_worktrees(
        &self,
        repository: &ValidatedRepository,
        cancellation: &NativeCancellation,
    ) -> NativeResult<Vec<WorktreeEntry>> {
        let output = self.git_checked_cancelled(
            repository.root(),
            &[
                "worktree".to_owned(),
                "list".to_owned(),
                "--porcelain".to_owned(),
                "-z".to_owned(),
            ],
            self.git_timeout,
            cancellation,
        )?;
        let primary = main_checkout(repository)?;
        let mut rows = parse_worktrees(&output, &primary);
        rows.truncate(MAX_WORKTREES);
        for row in &mut rows {
            if row.bare {
                continue;
            }
            let output = self.git_raw(
                &row.path,
                &[
                    "status".to_owned(),
                    "--porcelain".to_owned(),
                    "--untracked-files=normal".to_owned(),
                ],
                self.git_timeout,
                MAX_COMMAND_OUTPUT_BYTES,
                cancellation,
            );
            if let Ok(output) = output {
                row.dirty = row.dirty || !output.stdout.trim().is_empty();
            }
        }
        Ok(rows)
    }

    fn git_create_worktree(
        &self,
        repository: &ValidatedRepository,
        name: &str,
        from: Option<&str>,
        cancellation: &NativeCancellation,
    ) -> NativeResult<WorktreeEntry> {
        validate_branch(name, "worktree branch")?;
        if let Some(from) = from {
            validate_branch(from, "worktree source")?;
        }
        let check = vec![
            String::from("check-ref-format"),
            String::from("--branch"),
            name.to_owned(),
        ];
        self.git_checked_cancelled(repository.root(), &check, self.git_timeout, cancellation)?;
        let parent = repository
            .root
            .parent()
            .ok_or_else(|| invalid("repository", "repository has no parent directory"))?;
        let container = parent.join(format!(
            "{}-worktrees",
            repository
                .root
                .file_name()
                .and_then(|value| value.to_str())
                .unwrap_or("repository")
        ));
        let target = container.join(name);
        if target.exists() {
            return Err(NativeServiceError::InvalidInput {
                field: "name",
                message: String::from("that worktree path already exists"),
            });
        }
        let mut args = vec![
            "worktree".to_owned(),
            "add".to_owned(),
            "-b".to_owned(),
            name.to_owned(),
            target.display().to_string(),
        ];
        if let Some(from) = from {
            args.push(from.to_owned());
        }
        let first = self.git_raw(
            repository.root(),
            &args,
            self.git_timeout,
            MAX_COMMAND_OUTPUT_BYTES,
            cancellation,
        )?;
        if !first.status.success() && from.is_none() {
            let fallback = vec![
                "worktree".to_owned(),
                "add".to_owned(),
                target.display().to_string(),
                name.to_owned(),
            ];
            self.git_checked_cancelled(
                repository.root(),
                &fallback,
                self.git_timeout,
                cancellation,
            )?;
        } else {
            ensure_process_success("git", &first)?;
        }
        let created = canonical_directory(&target)?;
        let rows = self.git_worktrees(repository, cancellation)?;
        rows.into_iter()
            .find(|row| row.path == created)
            .ok_or_else(|| NativeServiceError::NotFound {
                capability: "created worktree",
            })
    }

    fn git_remove_worktrees(
        &self,
        repository: &ValidatedRepository,
        paths: &[PathBuf],
        cancellation: &NativeCancellation,
    ) -> NativeResult<()> {
        if paths.is_empty() || paths.len() > MAX_WORKTREES {
            return Err(invalid("paths", "pick one to thirty-two worktrees"));
        }
        let known = self.git_worktrees(repository, cancellation)?;
        for target in paths {
            let target = canonical_absolute(target)?;
            let row = known
                .iter()
                .find(|row| canonical_absolute(&row.path).ok().as_ref() == Some(&target))
                .ok_or_else(|| invalid("path", "that worktree is not on this repository's list"))?;
            if row.primary {
                return Err(invalid("path", "the main checkout cannot be deleted"));
            }
            if row.bare {
                return Err(invalid("path", "a bare repository cannot be deleted"));
            }
            if row.locked {
                return Err(invalid("path", "unlock the worktree before deleting it"));
            }
            let args = vec![
                "worktree".to_owned(),
                "remove".to_owned(),
                target.display().to_string(),
            ];
            self.git_checked_cancelled(repository.root(), &args, self.git_timeout, cancellation)?;
        }
        Ok(())
    }

    fn git_lines(
        &self,
        repository: &ValidatedRepository,
        args: &[&str],
        cancellation: &NativeCancellation,
        max_output: usize,
    ) -> NativeResult<Vec<String>> {
        let args = args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let output =
            self.git_checked_cancelled(repository.root(), &args, self.git_timeout, cancellation)?;
        Ok(output
            .lines()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .take(max_output / 2)
            .map(str::to_owned)
            .collect())
    }

    fn git_diff_output(
        &self,
        repository: &ValidatedRepository,
        args: &[String],
        cancellation: &NativeCancellation,
    ) -> NativeResult<DiffOutput> {
        let output = self.git_raw(
            repository.root(),
            args,
            self.git_timeout,
            MAX_GIT_STATUS_BYTES,
            cancellation,
        )?;
        if !output.status.success() {
            let fallback = if args.len() >= 4 && args[0] == "diff" && args[3] == "HEAD" {
                let mut fallback = vec![
                    "diff".to_owned(),
                    "--no-color".to_owned(),
                    "--no-ext-diff".to_owned(),
                ];
                if args.len() > 4 {
                    fallback.extend_from_slice(&args[4..]);
                }
                Some(fallback)
            } else {
                None
            };
            if let Some(fallback) = fallback {
                let output = self.git_raw(
                    repository.root(),
                    &fallback,
                    self.git_timeout,
                    MAX_GIT_STATUS_BYTES,
                    cancellation,
                )?;
                if !output.status.success() {
                    ensure_process_success("git", &output)?;
                }
                return Ok(truncate_diff(
                    process_text_with_limit(&output, MAX_GIT_STATUS_BYTES),
                    output.truncated,
                ));
            }
            ensure_process_success("git", &output)?;
        }
        Ok(truncate_diff(
            process_text_with_limit(&output, MAX_GIT_STATUS_BYTES),
            output.truncated,
        ))
    }

    fn git_checked(&self, cwd: &Path, args: &[&str], timeout: Duration) -> NativeResult<String> {
        let args = args
            .iter()
            .map(|value| (*value).to_owned())
            .collect::<Vec<_>>();
        let output = self.git_raw(
            cwd,
            &args,
            timeout,
            MAX_GIT_STATUS_BYTES,
            &NativeCancellation::default(),
        )?;
        ensure_process_success("git", &output)?;
        Ok(output.stdout)
    }

    fn git_checked_cancelled(
        &self,
        cwd: &Path,
        args: &[String],
        timeout: Duration,
        cancellation: &NativeCancellation,
    ) -> NativeResult<String> {
        let output = self.git_raw(cwd, args, timeout, MAX_GIT_STATUS_BYTES, cancellation)?;
        ensure_process_success("git", &output)?;
        Ok(output.stdout)
    }

    fn git_raw(
        &self,
        cwd: &Path,
        args: &[String],
        timeout: Duration,
        max_output: usize,
        cancellation: &NativeCancellation,
    ) -> NativeResult<ProcessOutput> {
        self.run_program(
            "git",
            &args.iter().map(OsString::from).collect::<Vec<_>>(),
            Some(cwd),
            timeout,
            max_output,
            cancellation,
            true,
        )
    }

    fn run_opener(&self, args: &[OsString], cancellation: &NativeCancellation) -> NativeResult<()> {
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(target_os = "windows")]
        let program = "explorer.exe";
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let program = "xdg-open";
        let output = self.run_program(
            program,
            args,
            None,
            self.action_timeout,
            MAX_COMMAND_OUTPUT_BYTES,
            cancellation,
            false,
        )?;
        ensure_process_success(program, &output)
    }

    fn run_revealer(
        &self,
        args: &[OsString],
        cancellation: &NativeCancellation,
    ) -> NativeResult<()> {
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(target_os = "windows")]
        let program = "explorer.exe";
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let program = "xdg-open";
        let output = self.run_program(
            program,
            args,
            None,
            self.action_timeout,
            MAX_COMMAND_OUTPUT_BYTES,
            cancellation,
            false,
        )?;
        ensure_process_success(program, &output)
    }

    fn run_browser(
        &self,
        args: &[OsString],
        cancellation: &NativeCancellation,
    ) -> NativeResult<()> {
        #[cfg(target_os = "macos")]
        let program = "open";
        #[cfg(target_os = "windows")]
        let program = "explorer.exe";
        #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
        let program = "xdg-open";
        let output = self.run_program(
            program,
            args,
            None,
            self.action_timeout,
            MAX_COMMAND_OUTPUT_BYTES,
            cancellation,
            false,
        )?;
        ensure_process_success(program, &output)
    }

    #[allow(clippy::too_many_arguments)]
    fn run_program(
        &self,
        program: &str,
        args: &[OsString],
        cwd: Option<&Path>,
        timeout: Duration,
        capture_limit: usize,
        cancellation: &NativeCancellation,
        git_environment: bool,
    ) -> NativeResult<ProcessOutput> {
        let mut command = Command::new(program);
        command
            .args(args)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if let Some(cwd) = cwd {
            command.current_dir(cwd);
        }
        if git_environment {
            command.env("GIT_TERMINAL_PROMPT", "0");
            command.env("GCM_INTERACTIVE", "Never");
            command.env("GIT_ASKPASS", "");
            let ssh = env::var("GIT_SSH_COMMAND").unwrap_or_else(|_| String::from("ssh"));
            command.env("GIT_SSH_COMMAND", format!("{ssh} -o BatchMode=yes"));
        }
        let child = command.spawn().map_err(|error| {
            if error.kind() == io::ErrorKind::NotFound {
                NativeServiceError::ExecutableMissing {
                    program: program.to_owned(),
                }
            } else {
                NativeServiceError::Io {
                    operation: "spawn process",
                    message: error.to_string(),
                }
            }
        })?;
        wait_for_process(child, program, timeout, capture_limit, cancellation)
    }
}

#[derive(Debug)]
struct ProcessOutput {
    stdout: String,
    stderr: String,
    status: ExitStatus,
    truncated: bool,
}

#[derive(Debug)]
struct CapturedOutput {
    bytes: Vec<u8>,
    truncated: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DiffOutput {
    text: String,
    truncated: bool,
}

fn wait_for_process(
    mut child: Child,
    program: &str,
    timeout: Duration,
    capture_limit: usize,
    cancellation: &NativeCancellation,
) -> NativeResult<ProcessOutput> {
    let stdout = child.stdout.take().ok_or_else(|| NativeServiceError::Io {
        operation: "capture process output",
        message: String::from("stdout was not piped"),
    })?;
    let stderr = child.stderr.take().ok_or_else(|| NativeServiceError::Io {
        operation: "capture process output",
        message: String::from("stderr was not piped"),
    })?;
    let stdout_thread = thread::spawn(move || capture_reader(stdout, capture_limit));
    let stderr_thread = thread::spawn(move || capture_reader(stderr, capture_limit));
    let started = Instant::now();
    let mut status = None;
    let mut failure = None;
    loop {
        if cancellation.is_cancelled() {
            let _ = child.kill();
            let _ = child.wait();
            failure = Some(NativeServiceError::Cancelled);
            break;
        }
        match child.try_wait() {
            Ok(Some(value)) => {
                status = Some(value);
                break;
            }
            Ok(None) => {
                if started.elapsed() >= timeout {
                    let _ = child.kill();
                    let _ = child.wait();
                    failure = Some(NativeServiceError::TimedOut {
                        program: program.to_owned(),
                    });
                    break;
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => {
                let _ = child.kill();
                let _ = child.wait();
                failure = Some(NativeServiceError::Io {
                    operation: "wait for process",
                    message: error.to_string(),
                });
                break;
            }
        }
    }
    let stdout = join_capture(stdout_thread, "stdout")?;
    let stderr = join_capture(stderr_thread, "stderr")?;
    if let Some(error) = failure {
        Err(error)
    } else {
        Ok(ProcessOutput {
            stdout: String::from_utf8_lossy(&stdout.bytes).into_owned(),
            stderr: String::from_utf8_lossy(&stderr.bytes).into_owned(),
            status: status.ok_or_else(|| NativeServiceError::Io {
                operation: "read process status",
                message: String::from("process status was unavailable"),
            })?,
            truncated: stdout.truncated || stderr.truncated,
        })
    }
}

fn capture_reader<R: Read>(mut reader: R, limit: usize) -> io::Result<CapturedOutput> {
    let mut bytes = Vec::with_capacity(limit.min(8192));
    let mut buffer = [0_u8; 8192];
    let mut truncated = false;
    loop {
        let read = reader.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        let available = limit.saturating_sub(bytes.len());
        let keep = read.min(available);
        bytes.extend_from_slice(&buffer[..keep]);
        if keep < read {
            truncated = true;
        }
    }
    Ok(CapturedOutput { bytes, truncated })
}

fn join_capture(
    handle: thread::JoinHandle<io::Result<CapturedOutput>>,
    stream: &'static str,
) -> NativeResult<CapturedOutput> {
    handle
        .join()
        .map_err(|_| NativeServiceError::Io {
            operation: "capture process output",
            message: format!("{stream} reader stopped"),
        })?
        .map_err(|error| NativeServiceError::Io {
            operation: "capture process output",
            message: error.to_string(),
        })
}

fn ensure_process_success(program: &str, output: &ProcessOutput) -> NativeResult<()> {
    if output.status.success() {
        Ok(())
    } else {
        Err(NativeServiceError::Process {
            program: program.to_owned(),
            code: output.status.code(),
            output: process_text(output),
        })
    }
}

fn process_text(output: &ProcessOutput) -> String {
    process_text_with_limit(output, MAX_COMMAND_OUTPUT_BYTES)
}

fn process_text_with_limit(output: &ProcessOutput, max_bytes: usize) -> String {
    let mut text = String::new();
    let stdout = output.stdout.trim();
    let stderr = output.stderr.trim();
    if !stdout.is_empty() {
        text.push_str(stdout);
    }
    if !stderr.is_empty() {
        if !text.is_empty() {
            text.push('\n');
        }
        text.push_str(stderr);
    }
    truncate_utf8(&text, max_bytes)
}

fn canonical_directory(path: &Path) -> NativeResult<PathBuf> {
    let path = canonical_existing(path)?;
    if !path.is_dir() {
        return Err(NativeServiceError::InvalidInput {
            field: "path",
            message: String::from("expected a directory"),
        });
    }
    Ok(path)
}

fn canonical_existing(path: &Path) -> NativeResult<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(invalid("path", "expected an absolute path"));
    }
    fs::canonicalize(path).map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            NativeServiceError::NotFound { capability: "path" }
        } else {
            NativeServiceError::Io {
                operation: "resolve path",
                message: error.to_string(),
            }
        }
    })
}

fn canonical_absolute(path: &Path) -> NativeResult<PathBuf> {
    if path.as_os_str().is_empty() || !path.is_absolute() {
        return Err(invalid("path", "expected an absolute path"));
    }
    if path.exists() {
        canonical_existing(path)
    } else {
        Ok(path.to_owned())
    }
}

fn ensure_lexical_inside(root: &Path, target: &Path) -> NativeResult<()> {
    if path_inside(root, target) {
        Ok(())
    } else {
        Err(NativeServiceError::OutsideRoot {
            path: target.to_owned(),
        })
    }
}

fn ensure_real_parent_inside(root: &Path, target: &Path) -> NativeResult<()> {
    let mut current = target;
    while !current.exists() {
        current = current
            .parent()
            .ok_or_else(|| NativeServiceError::OutsideRoot {
                path: target.to_owned(),
            })?;
    }
    let current = canonical_existing(current)?;
    if path_inside(root, &current) {
        Ok(())
    } else {
        Err(NativeServiceError::OutsideRoot {
            path: target.to_owned(),
        })
    }
}

fn path_inside(root: &Path, target: &Path) -> bool {
    target == root || target.strip_prefix(root).is_ok()
}

fn validate_relative_path(value: &str, field: &'static str) -> NativeResult<()> {
    if value.is_empty() || value.chars().count() > MAX_PATH_CHARS || value.contains('\0') {
        return Err(invalid(field, "path is empty, too long, or contains NUL"));
    }
    let path = Path::new(value);
    if path.is_absolute() || windows_absolute(value) || value.starts_with('-') {
        return Err(invalid(field, "path must stay inside the repository"));
    }
    if path
        .components()
        .any(|component| component == Component::ParentDir)
        || value.split('\\').any(|part| part == "..")
    {
        return Err(invalid(field, "path must stay inside the repository"));
    }
    Ok(())
}

fn validate_repo_paths(
    repository: &ValidatedRepository,
    paths: &[String],
) -> NativeResult<Vec<String>> {
    if paths.len() > MAX_COMMIT_PATHS {
        return Err(invalid("paths", "too many paths"));
    }
    let mut checked = Vec::with_capacity(paths.len());
    for path in paths {
        validate_relative_path(path, "path")?;
        let resolved = repository.root.join(path);
        ensure_lexical_inside(&repository.root, &resolved)?;
        ensure_real_parent_inside(&repository.root, &resolved)?;
        checked.push(path.trim_end_matches('/').to_owned());
    }
    Ok(checked)
}

fn validate_repo_path(repository: &ValidatedRepository, path: &str) -> NativeResult<PathBuf> {
    validate_relative_path(path, "path")?;
    let resolved = repository.root.join(path);
    ensure_lexical_inside(&repository.root, &resolved)?;
    ensure_real_parent_inside(&repository.root, &resolved)?;
    Ok(resolved)
}

fn require_paths(paths: &[String]) -> NativeResult<()> {
    if paths.is_empty() {
        Err(invalid("paths", "pick at least one path"))
    } else {
        Ok(())
    }
}

fn validate_identifier<'a>(value: &'a str, field: &'static str) -> NativeResult<&'a str> {
    if value.is_empty()
        || value.chars().count() > 256
        || value.contains('\0')
        || value.chars().any(char::is_control)
    {
        Err(invalid(field, "identifier is invalid"))
    } else {
        Ok(value)
    }
}

fn validate_branch(value: &str, field: &'static str) -> NativeResult<()> {
    validate_identifier(value, field)?;
    if value.starts_with('-')
        || value.starts_with('/')
        || windows_absolute(value)
        || value.contains('\\')
        || value.starts_with('.')
        || value.ends_with('.')
        || value.contains("..")
        || value.contains("//")
        || value.contains(' ')
    {
        return Err(invalid(field, "branch name is invalid"));
    }
    Ok(())
}

fn validate_external_url(value: &str) -> NativeResult<()> {
    if value.chars().count() > MAX_EXTERNAL_URL_CHARS
        || value.is_empty()
        || value.chars().any(char::is_control)
        || value.chars().any(char::is_whitespace)
    {
        return Err(invalid(
            "url",
            "only a bounded HTTP or HTTPS URL is allowed",
        ));
    }
    let scheme_end = value
        .find("://")
        .ok_or_else(|| invalid("url", "only HTTP and HTTPS URLs are allowed"))?;
    let scheme = &value[..scheme_end];
    if !scheme.eq_ignore_ascii_case("http") && !scheme.eq_ignore_ascii_case("https") {
        return Err(invalid("url", "only HTTP and HTTPS URLs are allowed"));
    }
    let authority = &value[scheme_end + 3..];
    let authority = authority.split(['/', '?', '#']).next().unwrap_or_default();
    let host_port = authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host);
    let valid_host = if let Some(rest) = host_port.strip_prefix('[') {
        let Some(end) = rest.find(']') else {
            return Err(invalid("url", "URL host is missing"));
        };
        let suffix = &rest[end + 1..];
        suffix.is_empty()
            || (suffix.starts_with(':')
                && suffix.len() > 1
                && suffix[1..].chars().all(|value| value.is_ascii_digit()))
    } else if host_port.matches(':').count() > 1 {
        false
    } else if let Some((host, port)) = host_port.rsplit_once(':') {
        !host.is_empty() && !port.is_empty() && port.chars().all(|value| value.is_ascii_digit())
    } else {
        !host_port.is_empty()
    };
    if !valid_host {
        return Err(invalid("url", "URL host is missing"));
    }
    Ok(())
}

fn validate_prompt(value: &str) -> NativeResult<()> {
    if value.is_empty() || value.chars().count() > 256 || value.chars().any(char::is_control) {
        Err(invalid("prompt", "prompt is invalid"))
    } else {
        Ok(())
    }
}

fn validate_dialog_default(path: Option<&Path>, folder: bool) -> NativeResult<Option<PathBuf>> {
    let Some(path) = path else {
        return Ok(None);
    };
    let path = canonical_existing(path)?;
    if path.to_string_lossy().chars().any(char::is_control) {
        return Err(invalid(
            "default_path",
            "path contains unsupported control characters",
        ));
    }
    if folder && !path.is_dir() {
        return Err(invalid("default_path", "expected a directory"));
    }
    if !folder && !path.is_file() && !path.is_dir() {
        return Err(invalid("default_path", "expected a file or directory"));
    }
    Ok(Some(path))
}

fn stable_folder_id(path: &Path) -> String {
    let mut hasher = DefaultHasher::new();
    path.hash(&mut hasher);
    format!("folder-{:016x}", hasher.finish())
}

fn editor_spec(editor: EditorId) -> EditorSpec {
    EDITORS
        .iter()
        .copied()
        .find(|spec| spec.id == editor)
        .unwrap_or(EDITORS[0])
}

fn editor_installed(editor: EditorSpec) -> bool {
    #[cfg(target_os = "macos")]
    {
        let home = env::var_os("HOME").map(PathBuf::from);
        [
            Some(PathBuf::from("/Applications")),
            home.map(|path| path.join("Applications")),
        ]
        .into_iter()
        .flatten()
        .map(|root| root.join(format!("{}.app", editor.bundle)))
        .any(|path| path.exists())
    }
    #[cfg(not(target_os = "macos"))]
    {
        let _ = editor;
        false
    }
}

#[cfg(target_os = "macos")]
fn mac_editor_bundle(editor: EditorId) -> NativeResult<PathBuf> {
    let home = env::var_os("HOME").map(PathBuf::from);
    [
        Some(PathBuf::from("/Applications")),
        home.map(|path| path.join("Applications")),
    ]
    .into_iter()
    .flatten()
    .map(|root| root.join(format!("{}.app", editor.bundle())))
    .find(|path| path.exists())
    .ok_or(NativeServiceError::NotFound {
        capability: "configured editor",
    })
}

#[cfg(target_os = "windows")]
fn windows_editor_command(editor: EditorId) -> Option<&'static str> {
    match editor {
        EditorId::Vscode => Some("code.exe"),
        EditorId::VscodeInsiders => Some("code-insiders.exe"),
        EditorId::Cursor => Some("cursor.exe"),
        EditorId::Windsurf => Some("windsurf.exe"),
        EditorId::Zed => Some("zed.exe"),
        EditorId::Antigravity => Some("antigravity.exe"),
        EditorId::Trae => Some("trae.exe"),
        EditorId::Kiro => Some("kiro.exe"),
        EditorId::Void => Some("void.exe"),
        EditorId::Positron => Some("positron.exe"),
        EditorId::Sublime => Some("sublime_text.exe"),
        EditorId::Atom => Some("atom.exe"),
        EditorId::Emacs => Some("emacs.exe"),
        EditorId::Webstorm => Some("webstorm64.exe"),
        EditorId::Intellij | EditorId::IntellijCe => Some("idea64.exe"),
        EditorId::Pycharm | EditorId::PycharmCe => Some("pycharm64.exe"),
        EditorId::Goland => Some("goland64.exe"),
        EditorId::Rustrover => Some("rustrover64.exe"),
        EditorId::Clion => Some("clion64.exe"),
        EditorId::Phpstorm => Some("phpstorm64.exe"),
        EditorId::Rubymine => Some("rubymine64.exe"),
        EditorId::Rider => Some("rider64.exe"),
        EditorId::Datagrip => Some("datagrip64.exe"),
        EditorId::Fleet => Some("fleet.exe"),
        EditorId::Eclipse => Some("eclipse.exe"),
        EditorId::AndroidStudio => Some("studio64.exe"),
        EditorId::Nova | EditorId::Bbedit | EditorId::Textmate | EditorId::Xcode => None,
    }
}

fn validate_read_only_git_args(args: &[String]) -> NativeResult<Vec<String>> {
    if args.is_empty() || args.len() > MAX_GIT_ARGS {
        return Err(invalid(
            "args",
            "a read-only Git command needs one to thirty-two arguments",
        ));
    }
    for arg in args {
        if arg.chars().count() > MAX_GIT_ARG_CHARS
            || arg.contains('\0')
            || arg == "!"
            || arg == "--config"
            || arg == "--exec-path"
            || arg == "--upload-pack"
            || arg == "--receive-pack"
            || arg == "--ext-diff"
            || arg == "--no-index"
            || arg == "--textconv"
            || arg.starts_with("--output")
            || arg.starts_with("--exec-path")
            || arg.starts_with("--upload-pack")
            || arg.starts_with("--receive-pack")
            || arg.starts_with("--pathspec-from-file")
            || arg == "--pathspec-file-nul"
            || arg.starts_with("--mailmap")
            || arg == "--git-dir"
            || arg.starts_with("--git-dir=")
            || arg == "--work-tree"
            || arg.starts_with("--work-tree=")
            || arg == "--delete"
            || arg == "--move"
            || arg == "--copy"
            || arg == "--edit-description"
            || arg == "--set-upstream-to"
            || arg == "--unset-upstream"
            || arg == "--track"
            || arg == "--no-track"
            || matches!(arg.as_str(), "-c" | "-C" | "-d" | "-D" | "-f" | "-m" | "-M")
        {
            return Err(invalid("args", "Git command argument is not allowed"));
        }
    }
    if args[0].starts_with('-') {
        return Err(invalid("args", "start with a read-only Git subcommand"));
    }
    let allowed = [
        "status",
        "diff",
        "log",
        "show",
        "branch",
        "rev-parse",
        "worktree",
    ];
    if !allowed.contains(&args[0].as_str()) {
        return Err(invalid(
            "args",
            "only read-only Git subcommands are available",
        ));
    }
    if args[0] == "worktree" && args.get(1).map(String::as_str) != Some("list") {
        return Err(invalid("args", "only git worktree list is available"));
    }
    Ok(args.to_owned())
}

fn path_from_git_output(cwd: &Path, output: &str) -> NativeResult<PathBuf> {
    let value = output
        .lines()
        .next()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| invalid("repository", "Git returned no path"))?;
    let path = PathBuf::from(value);
    if path.is_absolute() {
        Ok(path)
    } else {
        Ok(cwd.join(path))
    }
}

fn parse_status_z(text: &str) -> (String, String, u32, u32, Vec<GitFileEntry>) {
    let mut records = text.split('\0').collect::<Vec<_>>();
    if records.last() == Some(&"") {
        records.pop();
    }
    let header = records.first().copied().unwrap_or_default();
    let (branch, upstream, ahead, behind) = parse_status_header(header);
    let mut files = Vec::new();
    let mut index = 1;
    while index < records.len() {
        let record = records[index];
        index += 1;
        let bytes = record.as_bytes();
        if bytes.len() < 4 || bytes[2] != b' ' {
            continue;
        }
        let index_state = bytes[0] as char;
        let work_state = bytes[1] as char;
        let path = record[3..].to_owned();
        let from = if matches!(index_state, 'R' | 'C') || matches!(work_state, 'R' | 'C') {
            records.get(index).map(|value| {
                index += 1;
                (*value).to_owned()
            })
        } else {
            None
        };
        files.push(GitFileEntry {
            path,
            index: index_state,
            work: work_state,
            from,
        });
    }
    (branch, upstream, ahead, behind, files)
}

fn parse_status_header(header: &str) -> (String, String, u32, u32) {
    let value = header.strip_prefix("## ").unwrap_or(header);
    let value = value.strip_prefix("No commits yet on ").unwrap_or(value);
    let track_start = value.find(" [");
    let (names, tracking) = track_start.map_or((value, ""), |at| {
        (&value[..at], &value[at + 2..value.len().saturating_sub(1)])
    });
    let mut names = names.split_whitespace();
    let branch_value = names.next().unwrap_or("HEAD");
    let (branch, upstream) = branch_value
        .split_once("...")
        .map_or((branch_value, ""), |(branch, upstream)| (branch, upstream));
    let ahead = tracking
        .split(", ")
        .find_map(|value| {
            value
                .strip_prefix("ahead ")
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0);
    let behind = tracking
        .split(", ")
        .find_map(|value| {
            value
                .strip_prefix("behind ")
                .and_then(|value| value.parse().ok())
        })
        .unwrap_or(0);
    (branch.to_owned(), upstream.to_owned(), ahead, behind)
}

fn parse_history(text: &str) -> Vec<GitCommit> {
    text.split('\0')
        .filter_map(|record| {
            let record = record.trim();
            if record.is_empty() {
                return None;
            }
            let mut fields = record.split('\x01');
            let hash = fields.next()?.to_owned();
            let parents = fields
                .next()
                .unwrap_or_default()
                .split_whitespace()
                .map(str::to_owned)
                .collect();
            let when = fields
                .next()
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(0)
                .saturating_mul(1_000);
            let author = fields.next().unwrap_or_default().to_owned();
            let refs = fields
                .next()
                .unwrap_or_default()
                .split(", ")
                .map(|value| value.trim_start_matches("HEAD -> ").trim())
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect();
            let subject = fields.collect::<Vec<_>>().join("\x01");
            Some(GitCommit {
                hash,
                parents,
                subject,
                author,
                when,
                refs,
            })
        })
        .collect()
}

fn parse_worktrees(text: &str, primary: &Path) -> Vec<WorktreeEntry> {
    let mut rows = Vec::new();
    let mut path = None;
    let mut head = String::new();
    let mut branch = String::new();
    let mut bare = false;
    let mut detached = false;
    let mut locked = false;
    let mut prunable = false;
    let mut dirty = false;
    let flush = |rows: &mut Vec<WorktreeEntry>,
                 path: &mut Option<PathBuf>,
                 head: &mut String,
                 branch: &mut String,
                 bare: &mut bool,
                 detached: &mut bool,
                 locked: &mut bool,
                 prunable: &mut bool,
                 dirty: &mut bool| {
        let Some(path_value) = path.take() else {
            return;
        };
        rows.push(WorktreeEntry {
            primary: path_value == primary,
            path: path_value,
            head: std::mem::take(head),
            branch: std::mem::take(branch),
            bare: *bare,
            detached: *detached,
            locked: *locked,
            prunable: *prunable,
            dirty: *dirty,
        });
        *bare = false;
        *detached = false;
        *locked = false;
        *prunable = false;
        *dirty = false;
    };
    for field in text.split('\0') {
        if field.is_empty() {
            flush(
                &mut rows,
                &mut path,
                &mut head,
                &mut branch,
                &mut bare,
                &mut detached,
                &mut locked,
                &mut prunable,
                &mut dirty,
            );
        } else if let Some(value) = field.strip_prefix("worktree ") {
            flush(
                &mut rows,
                &mut path,
                &mut head,
                &mut branch,
                &mut bare,
                &mut detached,
                &mut locked,
                &mut prunable,
                &mut dirty,
            );
            path = Some(PathBuf::from(value));
        } else if let Some(value) = field.strip_prefix("HEAD ") {
            head = value.to_owned();
        } else if let Some(value) = field.strip_prefix("branch ") {
            branch = value.trim_start_matches("refs/heads/").to_owned();
        } else if field == "detached" {
            detached = true;
        } else if field == "bare" {
            bare = true;
        } else if field.starts_with("locked") {
            locked = true;
        } else if field.starts_with("prunable") {
            prunable = true;
        } else if field.starts_with("dirty") {
            dirty = true;
        }
    }
    flush(
        &mut rows,
        &mut path,
        &mut head,
        &mut branch,
        &mut bare,
        &mut detached,
        &mut locked,
        &mut prunable,
        &mut dirty,
    );
    rows
}

fn main_checkout(repository: &ValidatedRepository) -> NativeResult<PathBuf> {
    repository
        .common_dir
        .parent()
        .map(Path::to_owned)
        .ok_or_else(|| invalid("repository", "Git common directory has no parent"))
}

fn append_diff(target: &mut String, part: &str) -> bool {
    if part.is_empty() || target.len() >= MAX_DIFF_BYTES {
        return !part.is_empty();
    }
    if !target.is_empty() {
        target.push('\n');
    }
    let available = MAX_DIFF_BYTES.saturating_sub(target.len());
    let bounded = truncate_utf8(part, available);
    let truncated = bounded.len() < part.len();
    target.push_str(&bounded);
    truncated
}

fn truncate_diff(value: String, process_truncated: bool) -> DiffOutput {
    if value.len() <= MAX_DIFF_BYTES {
        return DiffOutput {
            text: value,
            truncated: process_truncated,
        };
    }
    let mut end = MAX_DIFF_BYTES;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    if let Some(newline) = value[..end].rfind('\n') {
        end = newline;
    }
    DiffOutput {
        text: value[..end].to_owned(),
        truncated: true,
    }
}

fn truncate_utf8(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while end > 0 && !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn invalid(field: &'static str, message: impl Into<String>) -> NativeServiceError {
    NativeServiceError::InvalidInput {
        field,
        message: message.into(),
    }
}

fn windows_absolute(value: &str) -> bool {
    let bytes = value.as_bytes();
    (bytes.len() >= 3 && bytes[1] == b':' && (bytes[2] == b'/' || bytes[2] == b'\\'))
        || value.starts_with("\\\\")
}

fn null_device() -> &'static str {
    if cfg!(target_os = "windows") {
        "NUL"
    } else {
        "/dev/null"
    }
}

#[cfg(target_os = "macos")]
fn applescript_string(value: &str) -> String {
    let mut escaped = String::with_capacity(value.len() + 2);
    for character in value.chars() {
        match character {
            '\\' => escaped.push_str("\\\\"),
            '"' => escaped.push_str("\\\""),
            '\n' => escaped.push_str("\\n"),
            '\r' => escaped.push_str("\\r"),
            character => escaped.push(character),
        }
    }
    format!("\"{escaped}\"")
}

#[cfg(target_os = "macos")]
fn folder_picker_script(prompt: &str, default: Option<&Path>) -> String {
    let location = default
        .map(|path| {
            format!(
                " default location POSIX file {}",
                applescript_string(&path.display().to_string())
            )
        })
        .unwrap_or_default();
    format!(
        "set picked to choose folder with prompt {}{}\nPOSIX path of picked",
        applescript_string(prompt),
        location
    )
}

#[cfg(target_os = "macos")]
fn file_picker_script(prompt: &str, default: Option<&Path>, multiple: bool) -> String {
    let location = default
        .map(|path| {
            format!(
                " default location POSIX file {}",
                applescript_string(&path.display().to_string())
            )
        })
        .unwrap_or_default();
    let allowed = if multiple { "true" } else { "false" };
    format!(
        "set picked to choose file with prompt {}{} multiple selections allowed {}\nset AppleScript's text item delimiters to character id 30\nif {} then\nset output to {}\nrepeat with itemRef in picked\nset end of output to POSIX path of itemRef\nend repeat\nreturn output as text\nelse\nreturn POSIX path of picked\nend if",
        applescript_string(prompt),
        location,
        allowed,
        allowed,
        "{}"
    )
}

#[cfg(target_os = "macos")]
fn parse_picker_output(output: &str) -> Vec<PathBuf> {
    let separator = char::from_u32(30).unwrap_or('\u{1e}');
    let output = output.trim_end_matches(['\r', '\n']);
    output
        .split(separator)
        .filter_map(|value| {
            let path = PathBuf::from(value);
            if path.is_absolute() && path.exists() {
                fs::canonicalize(path).ok()
            } else {
                None
            }
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn picker_cancelled(error: &NativeServiceError) -> bool {
    match error {
        NativeServiceError::Process { output, .. } => {
            output.to_ascii_lowercase().contains("user canceled") || output.contains("-128")
        }
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn external_url_validation_accepts_http_and_https_only() {
        assert!(validate_external_url("https://example.com/path?q=1").is_ok());
        assert!(validate_external_url("HTTP://example.com").is_ok());
        assert!(validate_external_url("https://[::1]:443/path").is_ok());
        assert!(validate_external_url("file:///tmp/a").is_err());
        assert!(validate_external_url("https://").is_err());
        assert!(validate_external_url("https://example.com:bad").is_err());
        assert!(validate_external_url("https://example.com/a b").is_err());
    }

    #[test]
    fn relative_paths_reject_escape_and_option_injection() {
        assert!(validate_relative_path("src/main.rs", "path").is_ok());
        assert!(validate_relative_path("../secrets", "path").is_err());
        assert!(validate_relative_path(r"src\..\secrets", "path").is_err());
        assert!(validate_relative_path("--help", "path").is_err());
        assert!(validate_relative_path("/tmp/file", "path").is_err());
    }

    #[test]
    fn branch_validation_rejects_git_ambiguous_names() {
        assert!(validate_branch("feature/gpui", "branch").is_ok());
        assert!(validate_branch("-c", "branch").is_err());
        assert!(validate_branch("feature..broken", "branch").is_err());
        assert!(validate_branch("feature//broken", "branch").is_err());
    }

    #[test]
    fn status_parser_preserves_branch_tracking_and_rename() {
        let input = "## dev...origin/dev [ahead 2, behind 1]\0M  src/main.rs\0R  src/new.rs\0src/old.rs\0?? notes.txt\0";
        let (branch, upstream, ahead, behind, files) = parse_status_z(input);
        assert_eq!(
            (branch, upstream, ahead, behind),
            ("dev".to_owned(), "origin/dev".to_owned(), 2, 1)
        );
        assert_eq!(files[0].path, "src/main.rs");
        assert_eq!(files[1].from.as_deref(), Some("src/old.rs"));
        assert_eq!(files[2].work, '?');
    }

    #[test]
    fn history_parser_preserves_parents_refs_and_milliseconds() {
        let input = "abc\x01def ghi\x011700000000\x01Ada\x01HEAD -> dev, origin/dev\x01subject\x00";
        let rows = parse_history(input);
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].parents, vec!["def", "ghi"]);
        assert_eq!(rows[0].when, 1_700_000_000_000);
        assert_eq!(rows[0].refs, vec!["dev", "origin/dev"]);
    }

    #[test]
    fn worktree_parser_marks_primary_and_flags() {
        let primary = PathBuf::from("/repo");
        let input = "worktree /repo\0HEAD abc\0branch refs/heads/dev\0\0worktree /repo-wt\0HEAD def\0detached\0locked reason\0prunable stale\0dirty\0";
        let rows = parse_worktrees(input, &primary);
        assert_eq!(rows.len(), 2);
        assert!(rows[0].primary);
        assert!(rows[1].detached);
        assert!(rows[1].locked);
        assert!(rows[1].prunable);
        assert!(rows[1].dirty);
    }

    #[test]
    fn read_only_git_arguments_are_allowlisted() {
        assert!(validate_read_only_git_args(&["status".to_owned(), "--short".to_owned()]).is_ok());
        assert!(validate_read_only_git_args(&["push".to_owned()]).is_err());
        assert!(
            validate_read_only_git_args(&["worktree".to_owned(), "remove".to_owned()]).is_err()
        );
        assert!(
            validate_read_only_git_args(&["-c".to_owned(), "core.fsmonitor=true".to_owned()])
                .is_err()
        );
        assert!(
            validate_read_only_git_args(&["diff".to_owned(), "--no-index".to_owned()]).is_err()
        );
        assert!(validate_read_only_git_args(&["branch".to_owned(), "-c".to_owned()]).is_err());
    }

    #[test]
    #[cfg(target_os = "macos")]
    fn applescript_values_are_escaped_as_literals() {
        assert_eq!(applescript_string("a\\b\"c\nd"), "\"a\\\\b\\\"c\\nd\"");
    }

    #[test]
    fn stable_folder_ids_are_path_specific() {
        assert_eq!(
            stable_folder_id(Path::new("/repo")),
            stable_folder_id(Path::new("/repo"))
        );
        assert_ne!(
            stable_folder_id(Path::new("/repo")),
            stable_folder_id(Path::new("/other"))
        );
    }

    #[test]
    fn diff_truncation_keeps_utf8_and_marks_state() {
        let value = "é".repeat(MAX_DIFF_BYTES);
        let output = truncate_diff(value, false);
        assert!(output.truncated);
        assert!(output.text.len() <= MAX_DIFF_BYTES);
        assert!(output.text.is_char_boundary(output.text.len()));
    }

    #[test]
    fn cancellation_flag_is_shared() {
        let cancellation = NativeCancellation::default();
        assert!(!cancellation.is_cancelled());
        let other = cancellation.clone();
        other.cancel();
        assert!(cancellation.is_cancelled());
    }

    #[test]
    fn git_service_round_trip_handles_uncommitted_and_committed_state() {
        let path = std::env::temp_dir().join(format!(
            "emma-native-services-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&path).unwrap();
        let services = NativeServices::new();
        assert_eq!(
            services
                .execute(NativeRequest::Git(GitRequest::Ready { path: path.clone() }))
                .unwrap(),
            NativeResponse::Git(GitResult::Ready(GitReadyStatus::NoRepository))
        );
        services
            .execute(NativeRequest::Git(GitRequest::Initialize {
                path: path.clone(),
            }))
            .unwrap();
        test_git(&path, &["config", "user.name", "Emma Tests"]);
        test_git(&path, &["config", "user.email", "emma@example.test"]);
        let repository = services.validate_repository(&path).unwrap();
        let file = path.join("notes.txt");
        fs::write(&file, "first\n").unwrap();
        let snapshot = services
            .execute(NativeRequest::Git(GitRequest::Status {
                repository: repository.clone(),
                include_diff: true,
            }))
            .unwrap();
        let NativeResponse::Git(GitResult::Snapshot(snapshot)) = snapshot else {
            panic!("unexpected Git response");
        };
        assert_eq!(snapshot.files[0].work, '?');
        assert!(snapshot.diff.contains("notes.txt"));
        services
            .execute(NativeRequest::Git(GitRequest::Stage {
                repository: repository.clone(),
                paths: vec![String::from("notes.txt")],
            }))
            .unwrap();
        let commit = services
            .execute(NativeRequest::Git(GitRequest::Commit {
                repository: repository.clone(),
                message: String::from("initial"),
                paths: vec![String::from("notes.txt")],
                amend: false,
            }))
            .unwrap();
        assert!(
            matches!(commit, NativeResponse::Git(GitResult::Commit { hash }) if !hash.is_empty())
        );
        let snapshot = services
            .execute(NativeRequest::Git(GitRequest::Status {
                repository,
                include_diff: false,
            }))
            .unwrap();
        let NativeResponse::Git(GitResult::Snapshot(snapshot)) = snapshot else {
            panic!("unexpected Git response");
        };
        assert!(snapshot.files.is_empty());
        let created = services
            .execute(NativeRequest::Git(GitRequest::CreateWorktree {
                repository: services.validate_repository(&path).unwrap(),
                name: String::from("test-worktree"),
                from: None,
            }))
            .unwrap();
        let NativeResponse::Git(GitResult::Worktrees(created)) = created else {
            panic!("unexpected worktree response");
        };
        let worktree_path = created[0].path.clone();
        let listed = services
            .execute(NativeRequest::Git(GitRequest::ListWorktrees {
                repository: services.validate_repository(&path).unwrap(),
            }))
            .unwrap();
        let NativeResponse::Git(GitResult::Worktrees(listed)) = listed else {
            panic!("unexpected worktree response");
        };
        assert!(listed.iter().any(|row| row.path == worktree_path));
        services
            .execute(NativeRequest::Git(GitRequest::RemoveWorktrees {
                repository: services.validate_repository(&path).unwrap(),
                paths: vec![worktree_path],
            }))
            .unwrap();
        fs::remove_dir_all(path).unwrap();
    }

    fn test_git(cwd: &Path, args: &[&str]) {
        let status = Command::new("git")
            .current_dir(cwd)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success());
    }

    #[test]
    fn editor_ids_match_renderer_catalog() {
        assert_eq!(
            EditorId::parse("vscode").unwrap().label(),
            "Visual Studio Code"
        );
        assert_eq!(
            EditorId::parse("android-studio").unwrap().key(),
            "android-studio"
        );
        assert!(EditorId::parse("unknown").is_err());
        assert_eq!(EDITORS.len(), 32);
    }
}
