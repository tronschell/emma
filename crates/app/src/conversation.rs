use std::rc::Rc;

use gpui::{
    AnyElement, Div, Entity, InteractiveElement as _, IntoElement, ParentElement as _, Role,
    SharedString, StatefulInteractiveElement as _, Styled as _, div, img,
    prelude::FluentBuilder as _, px,
};
use gpui_component::{
    Disableable as _, IconName, Selectable as _, Sizable as _, StyledExt as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputState, Textarea, TextareaState},
    scroll::ScrollableElement as _,
    v_flex,
};

use crate::asset_catalog::{
    ModelSource, brand_for_model, brand_for_provider, brand_render_data, filetype_asset_for_path,
    filetype_key_for_path,
};
use crate::theme::EmmaTheme;

pub const MAX_COMPOSER_CHARS: usize = 65_536;
pub const STALL_MS: u64 = 60_000;
pub const STALL_CALL_MS: u64 = 180_000;
pub const STEPS_SHOWN: usize = 0;
pub const COMPOSER_TEXTAREA_HEIGHT: f32 = 44.;
pub const COMPOSER_CONTROL_SIZE: f32 = 26.;
pub const ATTACHMENT_TILE_SIZE: f32 = 56.;
pub const CONTENT_COLUMN: f32 = 720.;
pub const USER_BUBBLE_COLUMN: f32 = 518.4;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConversationRole {
    User,
    Assistant,
    System,
}

impl ConversationRole {
    pub const fn label(self) -> &'static str {
        match self {
            Self::User => "You",
            Self::Assistant => "Emma",
            Self::System => "System",
        }
    }

    pub const fn id(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Assistant => "assistant",
            Self::System => "system",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PermissionMode {
    #[default]
    Ask,
    AcceptEdits,
    Auto,
    Full,
}

impl PermissionMode {
    pub const ALL: [Self; 4] = [Self::Ask, Self::AcceptEdits, Self::Auto, Self::Full];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Ask => "ask",
            Self::AcceptEdits => "acceptEdits",
            Self::Auto => "auto",
            Self::Full => "full",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Ask => "Ask",
            Self::AcceptEdits => "Accept edits",
            Self::Auto => "Auto",
            Self::Full => "Full access",
        }
    }

    pub const fn glyph(self) -> &'static str {
        match self {
            Self::Ask => "◈",
            Self::AcceptEdits => "◆",
            Self::Auto => "⬗",
            Self::Full => "⬥",
        }
    }

    pub const fn hint(self) -> &'static str {
        match self {
            Self::Ask => "Writes and commands ask first; app access asks once per turn.",
            Self::AcceptEdits => "File edits go through; commands and app access still ask.",
            Self::Auto => "A verifier reviews gated calls. App access always asks you.",
            Self::Full => {
                "Tools run automatically; app access still asks. Escape stops a computer run."
            }
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum RunState {
    Idle,
    Waiting,
    Streaming,
    Stalled,
    Failed,
    Stopped,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ConversationLoadState {
    #[default]
    Loading,
    Ready,
    Empty,
    Error(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StepStatus {
    Pending,
    InProgress,
    Completed,
    Failed,
    Cancelled,
}

impl StepStatus {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "in_progress",
            Self::Completed => "completed",
            Self::Failed => "failed",
            Self::Cancelled => "cancelled",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Pending => "pending",
            Self::InProgress => "working",
            Self::Completed => "done",
            Self::Failed => "failed",
            Self::Cancelled => "interrupted",
        }
    }

    pub const fn mark(self) -> &'static str {
        match self {
            Self::Pending => "◌",
            Self::InProgress => "⋯",
            Self::Completed => "✓",
            Self::Failed => "!",
            Self::Cancelled => "×",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DiffLineKind {
    Context,
    Added,
    Removed,
}

impl DiffLineKind {
    pub const fn mark(self) -> &'static str {
        match self {
            Self::Context => " ",
            Self::Added => "+",
            Self::Removed => "−",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiffLine {
    pub kind: DiffLineKind,
    pub line: usize,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct EditDiff {
    pub path: String,
    pub added: usize,
    pub removed: usize,
    pub hunks: Vec<DiffLine>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolStep {
    pub id: String,
    pub title: String,
    pub kind: String,
    pub tool_name: Option<String>,
    pub status: StepStatus,
    pub input: String,
    pub output: String,
    pub path: Option<String>,
    pub edit: Option<EditDiff>,
    pub artifact_id: Option<String>,
    pub thread_id: Option<String>,
    pub goal_thread_id: Option<String>,
}

impl ToolStep {
    pub fn label(&self) -> String {
        if let Some(edit) = &self.edit {
            return format!(
                "Edited {}",
                edit.path.rsplit(['/', '\\']).next().unwrap_or(&edit.path)
            );
        }
        let title = self.title.trim();
        if !title.is_empty() {
            title.to_owned()
        } else if !self.kind.trim().is_empty() {
            self.kind.trim().to_owned()
        } else {
            "tool call".to_owned()
        }
    }

    pub fn resolved_path(&self) -> Option<&str> {
        self.edit
            .as_ref()
            .map(|edit| edit.path.as_str())
            .or(self.path.as_deref())
            .or_else(|| {
                let tool_name = self.tool_name.as_deref()?;
                if !matches!(
                    tool_name,
                    "read_file"
                        | "file_info"
                        | "open_file"
                        | "write_file"
                        | "edit_file"
                        | "delete_file"
                        | "create_folder"
                        | "list_files"
                        | "look_at_image"
                ) {
                    return None;
                }
                self.path_argument().or_else(|| {
                    let (_, value) = self.title.split_once(' ')?;
                    let value = value.trim();
                    (value.contains('/') || value.contains('.')).then_some(value)
                })
            })
    }

    fn path_argument(&self) -> Option<&str> {
        let marker = self.input.find("\"path\"")? + "\"path\"".len();
        let rest = self.input[marker..].trim_start();
        let rest = rest.strip_prefix(':')?.trim_start();
        let rest = rest.strip_prefix('"')?;
        let end = rest
            .char_indices()
            .find(|(index, character)| {
                *character == '"'
                    && rest[..*index]
                        .chars()
                        .rev()
                        .take_while(|value| *value == '\\')
                        .count()
                        % 2
                        == 0
            })
            .map(|(index, _)| index)?;
        Some(&rest[..end])
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThinkingBlock {
    pub id: String,
    pub text: String,
    pub duration_ms: u64,
    pub tokens: usize,
    pub live: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualBlock {
    pub id: String,
    pub title: String,
    pub caption: String,
    pub content: String,
    pub kept: bool,
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConversationBlock {
    Markdown {
        id: String,
        text: String,
    },
    Thinking(ThinkingBlock),
    Tool(ToolStep),
    Notice {
        id: String,
        text: String,
        plain: bool,
    },
    Visual(VisualBlock),
}

impl ConversationBlock {
    pub fn id(&self) -> &str {
        match self {
            Self::Markdown { id, .. } => id,
            Self::Thinking(thinking) => &thinking.id,
            Self::Tool(step) => &step.id,
            Self::Notice { id, .. } => id,
            Self::Visual(visual) => &visual.id,
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum AttachmentKind {
    #[default]
    Attachment,
    File,
    Note,
    Artifact,
    Terminal,
    Diff,
    Visual,
    Component,
}

impl AttachmentKind {
    pub const fn id(&self) -> &'static str {
        match self {
            Self::Attachment => "attachment",
            Self::File => "file",
            Self::Note => "note",
            Self::Artifact => "artifact",
            Self::Terminal => "terminal",
            Self::Diff => "diff",
            Self::Visual => "visual",
            Self::Component => "component",
        }
    }

    pub const fn label(&self) -> &'static str {
        match self {
            Self::Attachment => "File",
            Self::File => "File",
            Self::Note => "Knowledge",
            Self::Artifact => "Artifact",
            Self::Terminal => "Terminal",
            Self::Diff => "Diff",
            Self::Visual => "Picture",
            Self::Component => "Built by Emma",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MessageAttachment {
    pub id: String,
    pub kind: AttachmentKind,
    pub name: String,
    pub path: Option<String>,
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct GenerationMeta {
    pub model: String,
    pub output_tokens: usize,
    pub duration_ms: u64,
    pub input_tokens: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NestedAgentStatus {
    Running,
    Waiting,
    Done,
    Failed,
    Stopped,
}

impl NestedAgentStatus {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Done => "done",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Running => "running",
            Self::Waiting => "waiting",
            Self::Done => "finished",
            Self::Failed => "failed",
            Self::Stopped => "stopped",
        }
    }

    pub const fn mark(self) -> &'static str {
        match self {
            Self::Running => "●",
            Self::Waiting => "◌",
            Self::Done => "✓",
            Self::Failed => "!",
            Self::Stopped => "×",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NestedAgent {
    pub id: String,
    pub name: String,
    pub brief: String,
    pub color: Option<String>,
    pub status: NestedAgentStatus,
    pub model: Option<String>,
    pub activity: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationMessage {
    pub id: String,
    pub role: ConversationRole,
    pub content: String,
    pub timestamp: String,
    pub generation: Option<GenerationMeta>,
    pub blocks: Vec<ConversationBlock>,
    pub attachments: Vec<MessageAttachment>,
    pub spawned: Vec<NestedAgent>,
}

impl ConversationMessage {
    pub fn new(
        id: impl Into<String>,
        role: ConversationRole,
        content: impl Into<String>,
        timestamp: impl Into<String>,
    ) -> Self {
        Self {
            id: id.into(),
            role,
            content: content.into(),
            timestamp: timestamp.into(),
            generation: None,
            blocks: Vec::new(),
            attachments: Vec::new(),
            spawned: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelCut {
    pub id: String,
    pub label: String,
    pub brand: Option<String>,
    pub after: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConversationEntry {
    Message(ConversationMessage),
    ContextCut { id: String },
    ModelCut(ModelCut),
}

impl ConversationEntry {
    pub fn id(&self) -> &str {
        match self {
            Self::Message(message) => &message.id,
            Self::ContextCut { id } => id,
            Self::ModelCut(mark) => &mark.id,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QueuedTurn {
    pub id: String,
    pub content: String,
    pub steerable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationRun {
    pub state: RunState,
    pub activity: String,
    pub since_ms: u64,
    pub quiet_ms: u64,
    pub working_call: bool,
    pub blocks: Vec<ConversationBlock>,
    pub pending: Option<QueuedTurn>,
    pub queued: Vec<QueuedTurn>,
    pub held: Vec<QueuedTurn>,
    pub draft: Option<String>,
    pub stop_confirmation: bool,
    pub error: Option<String>,
}

impl Default for ConversationRun {
    fn default() -> Self {
        Self {
            state: RunState::Idle,
            activity: String::new(),
            since_ms: 0,
            quiet_ms: 0,
            working_call: false,
            blocks: Vec::new(),
            pending: None,
            queued: Vec::new(),
            held: Vec::new(),
            draft: None,
            stop_confirmation: false,
            error: None,
        }
    }
}

impl ConversationRun {
    pub fn busy(&self) -> bool {
        matches!(
            self.state,
            RunState::Waiting | RunState::Streaming | RunState::Stalled
        )
    }

    pub fn stall_threshold_ms(&self) -> u64 {
        if self.working_call {
            STALL_CALL_MS
        } else {
            STALL_MS
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionSigil {
    Slash,
    At,
}

impl CompletionSigil {
    pub const fn glyph(self) -> char {
        match self {
            Self::Slash => '/',
            Self::At => '@',
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CompletionKind {
    Builtin,
    Tool,
    Skill,
    Mcp,
    Artifact,
    Page,
    File,
    Note,
    Component,
}

impl CompletionKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Builtin => "Built-in",
            Self::Tool => "Tool",
            Self::Skill => "Skill",
            Self::Mcp => "MCP",
            Self::Artifact => "Artifact",
            Self::Page | Self::Note => "Knowledge",
            Self::File => "File",
            Self::Component => "Built by Emma",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionItem {
    pub id: String,
    pub name: String,
    pub kind: CompletionKind,
    pub detail: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CompletionMenu {
    pub sigil: CompletionSigil,
    pub query: String,
    pub items: Vec<CompletionItem>,
    pub active: usize,
}

impl CompletionMenu {
    pub fn empty_message(&self) -> String {
        match self.sigil {
            CompletionSigil::At => format!(
                "Nothing matches “{}”. Artifacts, saved notes and the files of this thread's folders appear here.",
                self.query
            ),
            CompletionSigil::Slash => format!(
                "Nothing matches “{}”. Built-in tools, imported skills and MCP servers appear here.",
                self.query
            ),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelChoice {
    pub id: String,
    pub label: String,
    pub brand: Option<String>,
    pub route: Option<String>,
    pub effort: Option<String>,
}

impl Default for ModelChoice {
    fn default() -> Self {
        Self {
            id: String::new(),
            label: "Select model".to_owned(),
            brand: None,
            route: None,
            effort: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SourceOption {
    pub id: String,
    pub name: String,
    pub detail: String,
    pub kind: CompletionKind,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerAttachment {
    pub id: String,
    pub name: String,
    pub kind: AttachmentKind,
    pub path: Option<String>,
    pub thumbnail: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerSubmission {
    pub text: String,
    pub mode: PermissionMode,
    pub model: String,
    pub source: Option<String>,
    pub capability: Option<String>,
    pub attachments: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComposerState {
    pub text: String,
    pub caret: usize,
    pub selection_end: usize,
    pub composing: bool,
    pub mode: PermissionMode,
    pub model: ModelChoice,
    pub source_label: Option<String>,
    pub capability_label: Option<String>,
    pub sources: Vec<SourceOption>,
    pub capabilities: Vec<SourceOption>,
    pub models: Vec<ModelChoice>,
    pub attachments: Vec<ComposerAttachment>,
    pub completion: Option<CompletionMenu>,
    pub source_query: String,
    pub locked: bool,
    pub mode_open: bool,
    pub sources_open: bool,
    pub models_open: bool,
    pub capabilities_open: bool,
    pub stop_confirmation: bool,
    pub draft: Option<String>,
}

impl Default for ComposerState {
    fn default() -> Self {
        Self {
            text: String::new(),
            caret: 0,
            selection_end: 0,
            composing: false,
            mode: PermissionMode::Ask,
            model: ModelChoice::default(),
            source_label: None,
            capability_label: None,
            sources: Vec::new(),
            capabilities: Vec::new(),
            models: Vec::new(),
            attachments: Vec::new(),
            completion: None,
            source_query: String::new(),
            locked: false,
            mode_open: false,
            sources_open: false,
            models_open: false,
            capabilities_open: false,
            stop_confirmation: false,
            draft: None,
        }
    }
}

impl ComposerState {
    pub fn can_submit(&self) -> bool {
        !self.locked && !self.composing && !self.text.trim().is_empty()
    }

    pub fn submission(&self) -> Option<ComposerSubmission> {
        if !self.can_submit() || self.text.chars().count() > MAX_COMPOSER_CHARS {
            return None;
        }
        Some(ComposerSubmission {
            text: self.text.trim().to_owned(),
            mode: self.mode,
            model: self.model.id.clone(),
            source: self.source_label.clone(),
            capability: self.capability_label.clone(),
            attachments: self
                .attachments
                .iter()
                .map(|item| item.id.clone())
                .collect(),
        })
    }

    pub fn completion_active(&self) -> bool {
        self.completion.is_some() && !self.locked && !self.composing
    }

    pub fn key_intent(&self, key: ComposerKey) -> ComposerIntent {
        if self.composing {
            return ComposerIntent::Ignored;
        }
        if let Some(menu) = &self.completion {
            if !self.locked {
                match key {
                    ComposerKey::ArrowDown => return ComposerIntent::NextCompletion,
                    ComposerKey::ArrowUp => return ComposerIntent::PreviousCompletion,
                    ComposerKey::Enter { shift: false } | ComposerKey::Tab => {
                        return ComposerIntent::AcceptCompletion;
                    }
                    ComposerKey::Escape => return ComposerIntent::DismissCompletion,
                    _ => {}
                }
            }
            if menu.items.is_empty() && key == ComposerKey::Escape {
                return ComposerIntent::DismissCompletion;
            }
        }
        match key {
            ComposerKey::Enter { shift: false } if self.can_submit() => {
                if self.locked {
                    ComposerIntent::Ignored
                } else {
                    ComposerIntent::Submit
                }
            }
            ComposerKey::Enter { shift: true } => ComposerIntent::Newline,
            ComposerKey::Escape if self.stop_confirmation => ComposerIntent::Stop,
            ComposerKey::Escape => ComposerIntent::ConfirmStop,
            _ => ComposerIntent::Ignored,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComposerKey {
    Enter { shift: bool },
    Tab,
    ArrowUp,
    ArrowDown,
    Escape,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ComposerIntent {
    Submit,
    Newline,
    Stop,
    ConfirmStop,
    NextCompletion,
    PreviousCompletion,
    AcceptCompletion,
    DismissCompletion,
    Ignored,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScrollAnchor {
    pub at_end: bool,
    pub anchor_id: Option<String>,
    pub pending_to_end: bool,
}

impl Default for ScrollAnchor {
    fn default() -> Self {
        Self {
            at_end: true,
            anchor_id: None,
            pending_to_end: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectionState {
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NestedAgentPanel {
    pub id: String,
    pub title: String,
    pub status: NestedAgentStatus,
    pub entries: Vec<ConversationEntry>,
    pub run: ConversationRun,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ConversationPage {
    pub thread_id: String,
    pub thread_title: String,
    pub load_state: ConversationLoadState,
    pub entries: Vec<ConversationEntry>,
    pub run: ConversationRun,
    pub composer: ComposerState,
    pub scroll: ScrollAnchor,
    pub expanded_thinking: Vec<String>,
    pub expanded_steps: Vec<String>,
    pub expanded_tools: Vec<String>,
    pub selection: Option<SelectionState>,
    pub agent_panel: Option<NestedAgentPanel>,
    pub wide: bool,
    pub git_available: bool,
    pub git_open: bool,
    pub terminal_open: bool,
    pub browser_open: bool,
    pub inspector_open: bool,
}

impl Default for ConversationPage {
    fn default() -> Self {
        Self {
            thread_id: String::new(),
            thread_title: "New thread".to_owned(),
            load_state: ConversationLoadState::Loading,
            entries: Vec::new(),
            run: ConversationRun::default(),
            composer: ComposerState::default(),
            scroll: ScrollAnchor::default(),
            expanded_thinking: Vec::new(),
            expanded_steps: Vec::new(),
            expanded_tools: Vec::new(),
            selection: None,
            agent_panel: None,
            wide: false,
            git_available: false,
            git_open: false,
            terminal_open: false,
            browser_open: false,
            inspector_open: true,
        }
    }
}

impl ConversationPage {
    pub fn ready(
        thread_id: impl Into<String>,
        thread_title: impl Into<String>,
        entries: Vec<ConversationEntry>,
    ) -> Self {
        let load_state = if entries.is_empty() {
            ConversationLoadState::Empty
        } else {
            ConversationLoadState::Ready
        };
        Self {
            thread_id: thread_id.into(),
            thread_title: thread_title.into(),
            load_state,
            entries,
            ..Self::default()
        }
    }

    pub fn render(
        &self,
        theme: &EmmaTheme,
        callbacks: ConversationCallbacks,
        textarea: Option<&Entity<TextareaState>>,
        thread_name: Option<&Entity<InputState>>,
    ) -> Div {
        render_conversation(self, theme, callbacks, textarea, thread_name)
    }
}

#[derive(Clone)]
pub struct ConversationCallbacks {
    on_action: Rc<dyn Fn(ConversationAction)>,
}

impl ConversationCallbacks {
    pub fn new(on_action: impl Fn(ConversationAction) + 'static) -> Self {
        Self {
            on_action: Rc::new(on_action),
        }
    }

    pub fn noop() -> Self {
        Self::new(|_| {})
    }

    pub fn emit(&self, action: ConversationAction) {
        (self.on_action)(action);
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComposerAction {
    InputChanged {
        text: String,
        caret: usize,
        selection_end: usize,
    },
    CompositionChanged(bool),
    SetMode(PermissionMode),
    ToggleModeMenu,
    OpenSources,
    CloseSources,
    OpenModels,
    CloseModels,
    OpenCapabilities,
    CloseCapabilities,
    OpenAgentRuntime,
    SelectModel(ModelChoice),
    SelectCompletion(String),
    MoveCompletion(isize),
    DismissCompletion,
    SearchSources(String),
    AttachFiles,
    AddSource(String),
    RemoveAttachment(String),
    Send(ComposerSubmission),
    Queue(ComposerSubmission),
    Stop,
    ConfirmStop,
    KeepGoing,
    RestoreDraft,
    HistoryPrevious,
    HistoryNext,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ConversationAction {
    Composer(ComposerAction),
    CopyTurn { id: String, text: String },
    OpenAttachment { id: String, path: String },
    ToggleThinking(String),
    ToggleTool(String),
    ToggleSteps(String),
    OpenPath(String),
    OpenChanges(String),
    OpenArtifact(String),
    OpenThread(String),
    OpenGoal(String),
    OpenVisual(String),
    KeepVisual(String),
    PickVisual(String),
    OpenSettings(String),
    OpenAgent(String),
    CloseAgent,
    JumpToTurn(String),
    QuoteSelection(String),
    NewThread(String),
    ScrollToLatest,
    TranscriptScrolled { at_end: bool },
    Retry,
    TryAnotherModel,
    RenameThread(String),
    OpenGit,
    ToggleTerminal,
    ToggleBrowser,
    ToggleInspector,
    DropQueued(String),
    SteerQueued(String),
    ReleaseHeld(String),
    DropHeld(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MarkdownLine {
    Paragraph(String),
    Heading {
        level: u8,
        text: String,
    },
    Bullet {
        ordered: bool,
        depth: usize,
        text: String,
    },
    Quote(String),
    Code {
        language: String,
        text: String,
    },
    Rule,
}

pub fn markdown_lines(text: &str) -> Vec<MarkdownLine> {
    let mut lines = Vec::new();
    let mut paragraph = Vec::new();
    let mut code: Option<(String, Vec<String>)> = None;
    let flush_paragraph = |lines: &mut Vec<MarkdownLine>, paragraph: &mut Vec<String>| {
        if !paragraph.is_empty() {
            lines.push(MarkdownLine::Paragraph(paragraph.join("\n")));
            paragraph.clear();
        }
    };
    for line in text.replace("\r\n", "\n").split('\n') {
        if let Some((language, body)) = code.as_mut() {
            if line.trim_start().starts_with("```") {
                lines.push(MarkdownLine::Code {
                    language: language.clone(),
                    text: body.join("\n"),
                });
                code = None;
            } else {
                body.push(line.to_owned());
            }
            continue;
        }
        if let Some(fence) = line.trim_start().strip_prefix("```") {
            flush_paragraph(&mut lines, &mut paragraph);
            code = Some((fence.trim().to_owned(), Vec::new()));
            continue;
        }
        let trimmed = line.trim();
        if trimmed.is_empty() {
            flush_paragraph(&mut lines, &mut paragraph);
        } else if trimmed.starts_with('#') {
            let level = trimmed
                .chars()
                .take_while(|character| *character == '#')
                .count();
            if level <= 6 && trimmed.as_bytes().get(level) == Some(&b' ') {
                flush_paragraph(&mut lines, &mut paragraph);
                lines.push(MarkdownLine::Heading {
                    level: level as u8,
                    text: trimmed[level + 1..].trim().to_owned(),
                });
            } else {
                paragraph.push(line.to_owned());
            }
        } else if trimmed == "---" || trimmed == "***" || trimmed == "___" {
            flush_paragraph(&mut lines, &mut paragraph);
            lines.push(MarkdownLine::Rule);
        } else if let Some(text) = trimmed.strip_prefix("> ") {
            flush_paragraph(&mut lines, &mut paragraph);
            lines.push(MarkdownLine::Quote(text.to_owned()));
        } else if let Some(text) = list_item(line) {
            flush_paragraph(&mut lines, &mut paragraph);
            lines.push(text);
        } else {
            paragraph.push(line.to_owned());
        }
    }
    if let Some((language, body)) = code {
        lines.push(MarkdownLine::Code {
            language,
            text: body.join("\n"),
        });
    }
    flush_paragraph(&mut lines, &mut paragraph);
    lines
}

fn list_item(line: &str) -> Option<MarkdownLine> {
    let depth = line
        .chars()
        .take_while(|character| character.is_whitespace())
        .count()
        / 2;
    let content = line.trim_start();
    if let Some(text) = content
        .strip_prefix("- ")
        .or_else(|| content.strip_prefix("* "))
    {
        return Some(MarkdownLine::Bullet {
            ordered: false,
            depth,
            text: text.to_owned(),
        });
    }
    let digits = content.chars().take_while(char::is_ascii_digit).count();
    if digits > 0 && content.as_bytes().get(digits) == Some(&b'.') {
        return Some(MarkdownLine::Bullet {
            ordered: true,
            depth,
            text: content[digits + 1..].trim_start().to_owned(),
        });
    }
    None
}

pub fn split_thinking(text: &str) -> (String, String) {
    let trimmed = text.trim_start();
    let Some((open_end, open_name)) = ["think", "thinking", "reasoning"].iter().find_map(|name| {
        let open = format!("<{name}>");
        trimmed
            .get(..open.len())
            .filter(|value| value.eq_ignore_ascii_case(&open))
            .map(|_| (open.len(), *name))
    }) else {
        return (String::new(), text.to_owned());
    };
    let body = &trimmed[open_end..];
    let Some(close) = close_thinking_tag(body, open_name) else {
        return (body.trim().to_owned(), String::new());
    };
    let thinking = body[..close.0].trim().to_owned();
    let answer = body[close.0 + close.1..].trim_start().to_owned();
    (thinking, answer)
}

fn close_thinking_tag(body: &str, name: &str) -> Option<(usize, usize)> {
    let lower = body.to_ascii_lowercase();
    let prefix = format!("</{}", name.to_ascii_lowercase());
    let mut offset = 0;
    while let Some(found) = lower[offset..].find(&prefix) {
        let start = offset + found;
        let mut end = start + prefix.len();
        while lower
            .as_bytes()
            .get(end)
            .is_some_and(|byte| byte.is_ascii_whitespace())
        {
            end += 1;
        }
        if lower.as_bytes().get(end) == Some(&b'>') {
            return Some((start, end + 1 - start));
        }
        offset = start + 2;
    }
    None
}

fn sent_by_thread(content: &str) -> (Option<String>, &str) {
    const PREFIX: &str = "[thread ";
    const SUFFIX: &str = " messaged]\n";
    let Some(rest) = content.strip_prefix(PREFIX) else {
        return (None, content);
    };
    let Some(end) = rest.find(SUFFIX) else {
        return (None, content);
    };
    let sender = &rest[..end];
    if sender.is_empty()
        || sender.len() > 96
        || !sender
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
    {
        return (None, content);
    }
    (Some(sender.to_owned()), &rest[end + SUFFIX.len()..])
}

pub fn thought_tokens(text: &str) -> usize {
    (text.chars().count() / 4).max(1)
}

pub fn token_label(tokens: usize) -> String {
    if tokens < 1_000 {
        tokens.to_string()
    } else if tokens < 10_000 {
        format!("{:.1}k", tokens as f64 / 1_000.)
    } else {
        format!("{}k", tokens / 1_000)
    }
}

pub fn format_elapsed(milliseconds: u64) -> String {
    if milliseconds < 60_000 {
        format!("{}s", (milliseconds as f64 / 1_000.).round() as u64)
    } else {
        let minutes = milliseconds / 60_000;
        let seconds = (milliseconds % 60_000) / 1_000;
        format!("{minutes}m {seconds:02}s")
    }
}

pub fn composer_highlight_segments(
    text: &str,
    slash_names: &[String],
    at_names: &[String],
) -> Vec<HighlightSegment> {
    let mut segments = Vec::new();
    for (index, token) in text
        .split_inclusive(|character: char| character.is_whitespace())
        .enumerate()
    {
        let trimmed = token.trim_end_matches(char::is_whitespace);
        let hue = if trimmed.starts_with('/')
            && slash_names.iter().any(|name| trimmed[1..] == *name)
        {
            Some(0)
        } else if trimmed.starts_with('@') && at_names.iter().any(|name| trimmed[1..] == *name) {
            Some(6)
        } else {
            None
        };
        segments.push(HighlightSegment {
            id: index,
            text: token.to_owned(),
            hue,
        });
    }
    if segments.is_empty() && !text.is_empty() {
        segments.push(HighlightSegment {
            id: 0,
            text: text.to_owned(),
            hue: None,
        });
    }
    segments
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HighlightSegment {
    pub id: usize,
    pub text: String,
    pub hue: Option<u8>,
}

pub fn stalled(now_ms: u64, since_ms: u64, working_call: bool) -> bool {
    now_ms.saturating_sub(since_ms)
        >= if working_call {
            STALL_CALL_MS
        } else {
            STALL_MS
        }
}

pub fn render_conversation(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    textarea: Option<&Entity<TextareaState>>,
    thread_name: Option<&Entity<InputState>>,
) -> Div {
    let column = if page.wide {
        theme.dimensions.conversation_column_high
    } else {
        theme.dimensions.content_column
    };
    let header = render_thread_header(page, theme, callbacks.clone(), thread_name);
    let transcript = page
        .agent_panel
        .as_ref()
        .map(|panel| render_agent_panel(panel, theme, callbacks.clone()))
        .unwrap_or_else(|| render_transcript(page, theme, callbacks.clone(), column));
    let queue = render_queue(page, theme, callbacks.clone());
    let composer = render_composer(page, theme, callbacks, textarea);
    v_flex()
        .size_full()
        .min_w_0()
        .bg(theme.colors.bg)
        .text_color(theme.colors.text)
        .child(header)
        .child(transcript)
        .children(queue)
        .child(composer)
}

fn render_thread_header(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    thread_name: Option<&Entity<InputState>>,
) -> Div {
    h_flex()
        .group("conversation-thread-header")
        .flex_shrink_0()
        .items_center()
        .gap_4()
        .min_h(px(46.))
        .px_4()
        .py_2()
        .child(render_thread_name(page, theme, thread_name))
        .child(
            icon_action_button(
                &callbacks,
                format!("thread-info-{}", page.thread_id),
                "Show thread details",
                IconName::Info,
                ConversationAction::OpenAgent(page.thread_id.clone()),
                false,
                false,
            )
            .compact()
            .opacity(0.)
            .group_hover("conversation-thread-header", |style| style.opacity(1.))
            .focus_visible(|style| style.opacity(1.)),
        )
        .child(
            h_flex()
                .flex_1()
                .justify_end()
                .gap_1()
                .when(page.git_available, |actions| {
                    actions.child(
                        icon_action_button(
                            &callbacks,
                            format!("thread-git-{}", page.thread_id),
                            "Open the Git page",
                            IconName::Network,
                            ConversationAction::OpenGit,
                            false,
                            page.git_open,
                        )
                        .compact(),
                    )
                })
                .children([
                    icon_action_button(
                        &callbacks,
                        format!("thread-terminal-{}", page.thread_id),
                        "Open the terminal",
                        IconName::SquareTerminal,
                        ConversationAction::ToggleTerminal,
                        false,
                        page.terminal_open,
                    )
                    .compact(),
                    icon_action_button(
                        &callbacks,
                        format!("thread-browser-{}", page.thread_id),
                        "Open the browser pane",
                        IconName::Globe,
                        ConversationAction::ToggleBrowser,
                        false,
                        page.browser_open,
                    )
                    .compact(),
                    icon_action_button(
                        &callbacks,
                        format!("thread-inspector-{}", page.thread_id),
                        if page.inspector_open {
                            "Collapse thread inspector"
                        } else {
                            "Expand thread inspector"
                        },
                        if page.inspector_open {
                            IconName::PanelRightClose
                        } else {
                            IconName::PanelRightOpen
                        },
                        ConversationAction::ToggleInspector,
                        false,
                        page.inspector_open,
                    )
                    .compact(),
                ]),
        )
}

fn render_thread_name(
    page: &ConversationPage,
    theme: &EmmaTheme,
    state: Option<&Entity<InputState>>,
) -> AnyElement {
    match state {
        Some(state) => div()
            .id(format!("thread-title-{}", page.thread_id))
            .min_w(px(96.))
            .max_w(px(420.))
            .h(px(28.))
            .child(
                Input::new(state)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(true)
                    .h(px(28.))
                    .px_2()
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_md),
            )
            .into_any_element(),
        None => div()
            .id(format!("thread-title-{}", page.thread_id))
            .min_w(px(96.))
            .max_w(px(420.))
            .overflow_hidden()
            .text_ellipsis()
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_md)
            .child(page.thread_title.clone())
            .into_any_element(),
    }
}

fn icon_action_button(
    callbacks: &ConversationCallbacks,
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    icon: IconName,
    action: ConversationAction,
    disabled: bool,
    selected: bool,
) -> Button {
    let callbacks = callbacks.clone();
    let label = label.into();
    Button::new(id)
        .ghost()
        .xsmall()
        .icon(icon)
        .disabled(disabled)
        .selected(selected)
        .toggled(selected)
        .accessibility_label(label.clone())
        .tooltip(label)
        .on_click(move |_, _, _| callbacks.emit(action.clone()))
}

fn render_transcript(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    column: gpui::Pixels,
) -> Div {
    let mut body = v_flex()
        .flex_1()
        .min_w_0()
        .overflow_y_scrollbar()
        .gap_3()
        .p_5()
        .pb(theme.spacing.s8)
        .bg(theme.colors.bg);
    match &page.load_state {
        ConversationLoadState::Loading if page.entries.is_empty() && page.run.blocks.is_empty() => {
            body = body.child(status_message(
                theme,
                "Waiting for this agent's first turn…",
            ));
        }
        ConversationLoadState::Error(error) => {
            body = body.child(error_panel(theme, error, callbacks.clone()));
        }
        ConversationLoadState::Empty if page.entries.is_empty() && !page.run.busy() => {
            body = body.child(welcome_panel(theme));
        }
        _ => {}
    }
    for entry in &page.entries {
        body = body.child(render_entry(entry, theme, callbacks.clone(), page, column));
    }
    if let Some(pending) = &page.run.pending {
        body = body.child(render_pending_turn(pending, theme));
    }
    if !page.run.blocks.is_empty()
        && matches!(page.run.state, RunState::Streaming | RunState::Stalled)
    {
        body = body.child(render_streaming(page, theme, callbacks.clone(), column));
    }
    match page.run.state {
        RunState::Waiting if page.run.blocks.is_empty() => {
            body = body.child(status_message(
                theme,
                if page.run.activity.trim().is_empty() {
                    "getting started…"
                } else {
                    &page.run.activity
                },
            ));
        }
        RunState::Stalled => {
            body = body.child(render_stalled(
                theme,
                callbacks.clone(),
                page.run.quiet_ms,
                page.run.working_call,
            ));
        }
        RunState::Failed => {
            body = body.child(error_panel(
                theme,
                page.run.error.as_deref().unwrap_or("Something went wrong"),
                callbacks.clone(),
            ));
        }
        RunState::Stopped => {
            body = body.child(status_message(
                theme,
                "Agent stopped. Ask Emma to continue where it left off.",
            ));
        }
        _ => {}
    }
    let mut wrap = v_flex().relative().flex_1().min_w_0().child(body);
    if !page.scroll.at_end {
        wrap = wrap.child(
            action_button(
                &callbacks,
                format!("transcript-tail-{}", page.thread_id),
                "↓",
                ConversationAction::ScrollToLatest,
                false,
            )
            .compact()
            .self_center(),
        );
    }
    if let Some(selection) = &page.selection {
        wrap = wrap.child(render_selection_toolbar(selection, theme, callbacks));
    }
    wrap
}

fn render_entry(
    entry: &ConversationEntry,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    page: &ConversationPage,
    column: gpui::Pixels,
) -> Div {
    match entry {
        ConversationEntry::Message(message) => {
            render_message(message, theme, callbacks, page, column)
        }
        ConversationEntry::ContextCut { id: _ } => h_flex()
            .w_full()
            .max_w(column)
            .mx_auto()
            .items_center()
            .gap_2()
            .my_4()
            .text_size(theme.typography.fs_2xs)
            .font_family(theme.typography.font_mono.clone())
            .text_color(theme.colors.text_3)
            .child(div().flex_1().h(px(1.)).bg(theme.colors.border))
            .child("Context cleared")
            .child(div().flex_1().h(px(1.)).bg(theme.colors.border)),
        ConversationEntry::ModelCut(mark) => render_model_cut(mark, theme, column),
    }
}

fn render_message(
    message: &ConversationMessage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    page: &ConversationPage,
    column: gpui::Pixels,
) -> Div {
    let (from_thread, content) = sent_by_thread(&message.content);
    let mut article = v_flex()
        .min_w_0()
        .max_w(column)
        .mx_auto()
        .gap_2()
        .border_l_1()
        .border_color(theme.colors.border)
        .pl_4();
    if message.role == ConversationRole::User {
        article = v_flex()
            .min_w_0()
            .max_w(px(USER_BUBBLE_COLUMN))
            .ml_auto()
            .mr_0()
            .gap_2();
        article = article.bg(theme.colors.surface_3).p_3();
    }
    let mut thought = String::new();
    let mut explicit_thinking = false;
    for block in &message.blocks {
        if let ConversationBlock::Thinking(item) = block {
            explicit_thinking = true;
            thought.push_str(&item.text);
        }
    }
    let (parsed_thinking, parsed_answer) = split_thinking(content);
    if message.role == ConversationRole::Assistant && !explicit_thinking {
        thought = parsed_thinking;
    }
    if !thought.trim().is_empty() {
        let thinking_id = format!("{}-thinking", message.id);
        let expanded = page
            .expanded_thinking
            .iter()
            .any(|value| value == &thinking_id);
        let thinking = ThinkingBlock {
            id: thinking_id,
            text: thought.clone(),
            duration_ms: message
                .generation
                .as_ref()
                .map_or(0, |item| item.duration_ms),
            tokens: message
                .generation
                .as_ref()
                .map_or_else(|| thought_tokens(&thought), |item| item.output_tokens),
            live: None,
        };
        article = article.child(render_thinking(
            &thinking,
            expanded,
            theme,
            callbacks.clone(),
        ));
    }
    if !message.attachments.is_empty() {
        article = article.child(render_attachment_tray(
            &message.attachments,
            theme,
            callbacks.clone(),
            true,
        ));
    }
    if message.blocks.is_empty() {
        let text = if message.role == ConversationRole::Assistant {
            parsed_answer
        } else {
            content.to_owned()
        };
        article = article.child(render_markdown(&message.id, &text, theme, message.role));
    } else {
        article = article.child(render_blocks(
            &message.id,
            &message.blocks,
            theme,
            callbacks.clone(),
            page,
        ));
    }
    if !message.spawned.is_empty() {
        article = article.child(render_agent_chips(
            &message.id,
            &message.spawned,
            theme,
            callbacks.clone(),
        ));
    }
    article.child(render_message_meta(
        message,
        from_thread.as_deref(),
        content,
        theme,
        callbacks,
    ))
}

fn render_pending_turn(pending: &QueuedTurn, theme: &EmmaTheme) -> Div {
    v_flex()
        .max_w(px(USER_BUBBLE_COLUMN))
        .ml_auto()
        .gap_2()
        .bg(theme.colors.surface_3)
        .p_3()
        .child(render_markdown(
            &pending.id,
            &pending.content,
            theme,
            ConversationRole::User,
        ))
}

fn render_streaming(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    column: gpui::Pixels,
) -> Div {
    let id = format!("{}-streaming", page.thread_id);
    let mut article = v_flex()
        .max_w(column)
        .mx_auto()
        .gap_2()
        .border_l_1()
        .border_color(theme.colors.border)
        .pl_4();
    article = article.child(render_blocks(
        &id,
        &page.run.blocks,
        theme,
        callbacks.clone(),
        page,
    ));
    if !page.run.activity.trim().is_empty() {
        let live_thinking = ThinkingBlock {
            id: format!("{id}-live"),
            text: String::new(),
            duration_ms: page.run.quiet_ms,
            tokens: page
                .run
                .blocks
                .iter()
                .filter_map(block_text)
                .map(thought_tokens)
                .sum(),
            live: Some(page.run.activity.clone()),
        };
        article = article.child(render_thinking(&live_thinking, false, theme, callbacks));
    } else {
        article = article.child(
            div()
                .text_size(theme.typography.fs_2xs)
                .font_family(theme.typography.font_mono.clone())
                .text_color(theme.colors.text_3)
                .child("Streaming…"),
        );
    }
    article
}

fn block_text(block: &ConversationBlock) -> Option<&str> {
    match block {
        ConversationBlock::Markdown { text, .. } | ConversationBlock::Notice { text, .. } => {
            Some(text)
        }
        ConversationBlock::Thinking(item) => Some(&item.text),
        ConversationBlock::Tool(item) => Some(&item.output),
        ConversationBlock::Visual(item) => Some(&item.content),
    }
}

fn render_blocks(
    base_id: &str,
    blocks: &[ConversationBlock],
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    page: &ConversationPage,
) -> Div {
    let mut content = v_flex().gap_3().min_w_0();
    let mut index = 0;
    while index < blocks.len() {
        match &blocks[index] {
            ConversationBlock::Markdown { id, text } => {
                content = content.child(render_markdown(
                    id,
                    text,
                    theme,
                    ConversationRole::Assistant,
                ));
                index += 1;
            }
            ConversationBlock::Thinking(item) => {
                let expanded = page.expanded_thinking.iter().any(|value| value == &item.id);
                content = content.child(render_thinking(item, expanded, theme, callbacks.clone()));
                index += 1;
            }
            ConversationBlock::Notice { id, text, plain } => {
                content = content.child(render_notice(id, text, *plain, theme, callbacks.clone()));
                index += 1;
            }
            ConversationBlock::Visual(visual) => {
                content = content.child(render_visual(visual, theme, callbacks.clone()));
                index += 1;
            }
            ConversationBlock::Tool(_) => {
                let start = index;
                while index < blocks.len() && matches!(blocks[index], ConversationBlock::Tool(_)) {
                    index += 1;
                }
                let steps = blocks[start..index]
                    .iter()
                    .filter_map(|block| match block {
                        ConversationBlock::Tool(step) => Some(step),
                        _ => None,
                    })
                    .collect::<Vec<_>>();
                content = content.child(render_steps(
                    base_id,
                    &steps,
                    theme,
                    callbacks.clone(),
                    page,
                ));
            }
        }
    }
    content
}

fn render_markdown(id: &str, text: &str, theme: &EmmaTheme, role: ConversationRole) -> Div {
    let mut body = v_flex()
        .min_w_0()
        .max_w(if role == ConversationRole::User {
            px(USER_BUBBLE_COLUMN)
        } else {
            px(CONTENT_COLUMN)
        })
        .gap_3()
        .text_size(theme.typography.fs_md)
        .text_color(theme.colors.text);
    for (index, line) in markdown_lines(text).into_iter().enumerate() {
        let child = match line {
            MarkdownLine::Paragraph(value) => render_multiline(
                format!("{id}-paragraph-{index}"),
                &value,
                theme,
                theme.typography.fs_md,
                theme.colors.text,
            ),
            MarkdownLine::Heading { level, text } => div()
                .text_size(if level <= 2 {
                    theme.typography.fs_lg
                } else {
                    theme.typography.fs_md
                })
                .font_bold()
                .child(text),
            MarkdownLine::Bullet {
                ordered,
                depth,
                text,
            } => h_flex()
                .gap_2()
                .pl(px((depth as f32 + 1.) * 16.))
                .child(if ordered { "·" } else { "•" })
                .child(render_multiline(
                    format!("{id}-item-{index}"),
                    &text,
                    theme,
                    theme.typography.fs_md,
                    theme.colors.text,
                )),
            MarkdownLine::Quote(value) => render_multiline(
                format!("{id}-quote-{index}"),
                &value,
                theme,
                theme.typography.fs_md,
                theme.colors.text_2,
            )
            .border_l_1()
            .border_color(theme.colors.border_strong)
            .pl_3(),
            MarkdownLine::Code { language, text } => {
                let mut code = v_flex()
                    .gap_1()
                    .max_w(px(CONTENT_COLUMN))
                    .border_l_1()
                    .border_color(theme.colors.border)
                    .pl_3()
                    .font_family(theme.typography.font_code.clone())
                    .text_size(theme.typography.fs_sm)
                    .text_color(theme.colors.text_2);
                if !language.is_empty() {
                    code = code.child(
                        div()
                            .text_size(theme.typography.fs_2xs)
                            .text_color(theme.colors.text_3)
                            .child(language),
                    );
                }
                code.child(render_multiline(
                    format!("{id}-code-text-{index}"),
                    &text,
                    theme,
                    theme.typography.fs_sm,
                    theme.colors.text_2,
                ))
            }
            MarkdownLine::Rule => div().h(px(1.)).w_full().bg(theme.colors.border),
        };
        body = body.child(child);
    }
    body
}

fn render_multiline(
    id: impl Into<SharedString>,
    text: &str,
    theme: &EmmaTheme,
    size: gpui::Pixels,
    color: gpui::Hsla,
) -> Div {
    let id = id.into();
    let mut body = v_flex().min_w_0().text_size(size).text_color(color);
    for (index, line) in text.split('\n').enumerate() {
        body = body.child(
            div()
                .id(format!("line-{id}-{index}"))
                .min_w_0()
                .text_color(color)
                .child(line.to_owned()),
        );
    }
    if text.is_empty() {
        body = body.child(div().text_color(theme.colors.text_3).child(" "));
    }
    body
}

fn render_thinking(
    thinking: &ThinkingBlock,
    expanded: bool,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let summary = if let Some(activity) = thinking.live.as_deref() {
        format!(
            "{} · {} tokens · {activity}",
            format_elapsed(thinking.duration_ms),
            token_label(thinking.tokens)
        )
    } else if thinking.duration_ms > 0 {
        format!(
            "Thought for {} · {} tokens",
            format_elapsed(thinking.duration_ms),
            token_label(thinking.tokens)
        )
    } else {
        format!("Thought · {} tokens", token_label(thinking.tokens))
    };
    let summary = summary.to_ascii_uppercase();
    let mut details = v_flex()
        .max_w(px(CONTENT_COLUMN))
        .gap_2()
        .text_color(theme.colors.text_3)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs);
    details = details.child(
        action_button(
            &callbacks,
            format!("thinking-toggle-{}", thinking.id),
            summary,
            ConversationAction::ToggleThinking(thinking.id.clone()),
            false,
        )
        .ghost()
        .small(),
    );
    if expanded || thinking.live.is_some() {
        details = details.child(
            render_multiline(
                format!("{}-body", thinking.id),
                &thinking.text,
                theme,
                theme.typography.fs_sm,
                theme.colors.text_3,
            )
            .border_l_1()
            .border_color(theme.colors.border)
            .pl_3(),
        );
    }
    details
}

fn render_steps(
    base_id: &str,
    steps: &[&ToolStep],
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    page: &ConversationPage,
) -> Div {
    if steps.is_empty() {
        return v_flex();
    }
    let shown_count = if steps.len() > STEPS_SHOWN + 1 {
        STEPS_SHOWN
    } else {
        steps.len()
    };
    let mut list = v_flex()
        .gap_1()
        .max_w(px(CONTENT_COLUMN))
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs);
    for step in steps.iter().take(shown_count) {
        list = list.child(render_step(step, theme, callbacks.clone(), page));
    }
    let rest = &steps[shown_count..];
    if !rest.is_empty() {
        let group_id = format!("{base_id}-steps-more");
        let expanded = page.expanded_steps.iter().any(|value| value == &group_id);
        let latest = rest.last().expect("rest is not empty");
        let mut more = v_flex().gap_1().child(
            action_button(
                &callbacks,
                format!("steps-toggle-{group_id}"),
                format!("› {} · {} more", latest.label(), rest.len()),
                ConversationAction::ToggleSteps(group_id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
        if expanded {
            for step in rest {
                more = more.child(render_step(step, theme, callbacks.clone(), page));
            }
        }
        list = list.child(more);
    }
    list
}

fn render_step(
    step: &ToolStep,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    page: &ConversationPage,
) -> Div {
    let expanded = page.expanded_tools.iter().any(|value| value == &step.id);
    let mut row = v_flex()
        .gap_1()
        .min_w_0()
        .text_color(step_color(step.status, theme));
    let icon = step_mark(step);
    let path = step.resolved_path().map(str::to_owned);
    let mut summary = h_flex()
        .id(format!("step-summary-{}", step.id))
        .items_center()
        .gap_2()
        .min_w_0()
        .child(div().flex_shrink_0().child(icon));
    let label = step.label();
    if let Some(path) = path.clone() {
        summary = summary.child(
            action_button(
                &callbacks,
                format!("step-path-{}", step.id),
                label,
                ConversationAction::OpenPath(path),
                false,
            )
            .ghost()
            .small(),
        );
    } else {
        summary = summary.child(
            div()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .text_color(theme.colors.text_2)
                .child(label),
        );
    }
    summary = summary.child(
        div()
            .text_color(step_color(step.status, theme))
            .child(step.status.label()),
    );
    row = row.child(summary);
    if step.edit.is_some()
        || step.kind == "verifier"
        || !step.input.is_empty()
        || !step.output.is_empty()
    {
        row = row.child(
            action_button(
                &callbacks,
                format!("step-details-{}", step.id),
                if expanded {
                    "Hide details"
                } else {
                    "Show details"
                },
                ConversationAction::ToggleTool(step.id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
    }
    if expanded {
        if let Some(edit) = &step.edit {
            row = row.child(render_edit_diff(step, edit, theme, callbacks.clone()));
        } else if step.kind == "verifier" {
            row = row.child(render_review(step, theme));
        } else {
            if !step.input.is_empty() {
                row = row.child(render_tool_detail("Input", &step.input, theme));
            }
            if !step.output.is_empty() {
                row = row.child(render_tool_detail("Output", &step.output, theme));
            }
        }
    }
    if step.status == StepStatus::Cancelled {
        row = row.child(div().text_color(theme.colors.text_3).child("interrupted"));
    }
    if let Some(id) = &step.artifact_id {
        row = row.child(
            action_button(
                &callbacks,
                format!("step-artifact-{}", step.id),
                "Open artifact",
                ConversationAction::OpenArtifact(id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
    }
    if let Some(id) = &step.thread_id {
        row = row.child(
            action_button(
                &callbacks,
                format!("step-thread-{}", step.id),
                "Open thread",
                ConversationAction::OpenThread(id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
    }
    if let Some(id) = &step.goal_thread_id {
        row = row.child(
            action_button(
                &callbacks,
                format!("step-goal-{}", step.id),
                "Open goal",
                ConversationAction::OpenGoal(id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
    }
    row
}

fn step_mark(step: &ToolStep) -> &'static str {
    if step.edit.is_some() {
        return "✎";
    }
    match step.tool_name.as_deref().or(Some(step.kind.as_str())) {
        Some("read_file" | "read_tool_result" | "open_file" | "read") => "▤",
        Some("grep_files" | "glob_files" | "semantic_search" | "web_search" | "search") => "⌕",
        Some("edit_file" | "write_file" | "edit") => "✎",
        Some("terminal" | "run_command" | "execute") => "›_",
        Some("web_fetch" | "fetch") => "↗",
        Some("delete_file" | "delete") => "⌫",
        Some("subagent") => "⌁",
        _ => "◇",
    }
}

fn step_color(status: StepStatus, theme: &EmmaTheme) -> gpui::Hsla {
    match status {
        StepStatus::Failed => theme.colors.orange,
        StepStatus::Cancelled => theme.colors.text_3,
        StepStatus::Pending | StepStatus::InProgress => theme.colors.text_2,
        StepStatus::Completed => theme.colors.text_3,
    }
}

fn render_edit_diff(
    step: &ToolStep,
    edit: &EditDiff,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let mut body = v_flex()
        .gap_1()
        .pl_3()
        .border_l_1()
        .border_color(theme.colors.border)
        .font_family(theme.typography.font_code.clone());
    body = body.child(
        h_flex()
            .gap_2()
            .child(
                div()
                    .text_color(theme.colors.lime)
                    .child(format!("+{}", edit.added)),
            )
            .child(
                div()
                    .text_color(theme.colors.danger)
                    .child(format!("−{}", edit.removed)),
            )
            .child(
                action_button(
                    &callbacks,
                    format!("edit-path-{}", step.id),
                    edit.path.clone(),
                    ConversationAction::OpenChanges(edit.path.clone()),
                    false,
                )
                .ghost()
                .small(),
            ),
    );
    if edit.hunks.is_empty() {
        body = body.child(
            div()
                .text_color(theme.colors.text_3)
                .child("Emma no longer has the text of this edit."),
        );
    } else {
        for (index, line) in edit.hunks.iter().enumerate() {
            let color = match line.kind {
                DiffLineKind::Added => theme.colors.lime,
                DiffLineKind::Removed => theme.colors.danger,
                DiffLineKind::Context => theme.colors.text_3,
            };
            body = body.child(
                h_flex()
                    .id(format!("diff-line-{}-{index}", step.id))
                    .gap_2()
                    .text_color(color)
                    .child(format!("{:>4}", line.line))
                    .child(format!("{}{}", line.kind.mark(), line.text)),
            );
        }
    }
    body
}

fn render_review(step: &ToolStep, theme: &EmmaTheme) -> Div {
    v_flex()
        .gap_2()
        .pl_3()
        .border_l_1()
        .border_color(theme.colors.border)
        .child(div().font_bold().child("Context sent to the verifier"))
        .child(render_tool_detail_value(&step.input, theme))
        .child(div().font_bold().child("What the verifier answered"))
        .child(render_tool_detail_value(&step.output, theme))
}

fn render_tool_detail(label: &str, value: &str, theme: &EmmaTheme) -> Div {
    v_flex()
        .gap_1()
        .child(div().font_bold().child(label.to_owned()))
        .child(render_tool_detail_value(value, theme))
}

fn render_tool_detail_value(value: &str, theme: &EmmaTheme) -> Div {
    render_multiline(
        "tool-detail-value",
        if value.is_empty() { "(nothing)" } else { value },
        theme,
        theme.typography.fs_2xs,
        theme.colors.text_3,
    )
}

fn render_notice(
    id: &str,
    text: &str,
    plain: bool,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let mut notice = h_flex()
        .w_full()
        .items_center()
        .gap_2()
        .my_4()
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .text_color(theme.colors.text_3)
        .child(div().flex_1().h(px(1.)).bg(theme.colors.border))
        .child(render_multiline(
            format!("{id}-text"),
            text,
            theme,
            theme.typography.fs_2xs,
            theme.colors.text_3,
        ));
    if !plain {
        notice = notice.child(
            action_button(
                &callbacks,
                format!("notice-settings-{id}"),
                "Change in settings",
                ConversationAction::OpenSettings("harness".to_owned()),
                false,
            )
            .ghost()
            .small(),
        );
    }
    notice.child(div().flex_1().h(px(1.)).bg(theme.colors.border))
}

fn render_stalled(
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    since_ms: u64,
    _working_call: bool,
) -> Div {
    let text = format!(
        "This model is taking too long — nothing for {}",
        format_elapsed(since_ms),
    );
    h_flex()
        .w_full()
        .items_center()
        .gap_2()
        .my_4()
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .text_color(theme.colors.orange)
        .child(div().flex_1().h(px(1.)).bg(theme.colors.border))
        .child(text)
        .child(
            action_button(
                &callbacks,
                "stalled-model",
                "Try another model",
                ConversationAction::TryAnotherModel,
                false,
            )
            .ghost()
            .small(),
        )
        .child(div().flex_1().h(px(1.)).bg(theme.colors.border))
}

fn render_visual(visual: &VisualBlock, theme: &EmmaTheme, callbacks: ConversationCallbacks) -> Div {
    let mut card = v_flex()
        .gap_2()
        .max_w(px(CONTENT_COLUMN))
        .border_1()
        .border_color(theme.colors.border)
        .bg(theme.colors.surface)
        .p_3()
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(div().font_bold().child(visual.title.clone()))
                .child(
                    h_flex()
                        .gap_1()
                        .child(
                            action_button(
                                &callbacks,
                                format!("visual-keep-{}", visual.id),
                                if visual.kept { "Kept" } else { "Keep" },
                                ConversationAction::KeepVisual(visual.id.clone()),
                                visual.kept,
                            )
                            .ghost()
                            .small(),
                        )
                        .child(
                            action_button(
                                &callbacks,
                                format!("visual-pick-{}", visual.id),
                                "Add to chat",
                                ConversationAction::PickVisual(visual.id.clone()),
                                false,
                            )
                            .ghost()
                            .small(),
                        ),
                ),
        );
    if visual.content.is_empty() {
        card = card.child(
            div()
                .text_color(theme.colors.text_3)
                .child("Visual unavailable"),
        );
    } else {
        card = card.child(render_markdown(
            &format!("{}-content", visual.id),
            &visual.content,
            theme,
            ConversationRole::Assistant,
        ));
    }
    if !visual.caption.is_empty() {
        card = card.child(
            div()
                .text_size(theme.typography.fs_2xs)
                .text_color(theme.colors.text_3)
                .child(visual.caption.clone()),
        );
    }
    card
}

fn render_agent_chips(
    _base_id: &str,
    agents: &[NestedAgent],
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let mut chips = h_flex().flex_wrap().gap_2();
    for agent in agents {
        chips = chips.child(
            action_button(
                &callbacks,
                format!("agent-chip-{}", agent.id),
                format!(
                    "{} {} · {}",
                    agent.status.mark(),
                    agent.name,
                    agent.status.label()
                ),
                ConversationAction::OpenAgent(agent.id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
    }
    chips
        .text_size(theme.typography.fs_2xs)
        .font_family(theme.typography.font_mono.clone())
}

fn render_message_meta(
    message: &ConversationMessage,
    from_thread: Option<&str>,
    content: &str,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let mut meta = h_flex()
        .items_center()
        .gap_3()
        .mt_2()
        .text_size(theme.typography.fs_2xs)
        .font_family(theme.typography.font_mono.clone())
        .text_color(theme.colors.text_3);
    if let Some(from_thread) = from_thread {
        meta = meta.child(div().child(format!("thread {from_thread} messaged:")));
    }
    meta = meta.child(
        action_button(
            &callbacks,
            format!("copy-turn-{}", message.id),
            "Copy",
            ConversationAction::CopyTurn {
                id: message.id.clone(),
                text: if message.role == ConversationRole::Assistant {
                    split_thinking(content).1
                } else {
                    content.to_owned()
                },
            },
            false,
        )
        .ghost()
        .small(),
    );
    if let Some(generation) = &message.generation {
        let mut model = h_flex().gap_1().items_center();
        model = model.child(render_brand(theme, &generation.model, None));
        model = model.child(div().child(generation.model.clone()));
        meta = meta.child(model);
        if generation.duration_ms > 0 {
            let rate = generation.output_tokens as f64 / generation.duration_ms as f64 * 1_000.;
            meta = meta.child(
                div()
                    .text_color(theme.colors.orange)
                    .child(format!("{:.0} tok/s", rate)),
            );
        }
    }
    if !message.timestamp.is_empty() {
        meta = meta.child(div().child(message.timestamp.clone()));
    }
    meta
}

fn render_model_cut(mark: &ModelCut, theme: &EmmaTheme, column: gpui::Pixels) -> Div {
    let mut row = h_flex()
        .w_full()
        .max_w(column)
        .mx_auto()
        .items_center()
        .gap_2()
        .my_4()
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .text_color(theme.colors.text_3)
        .child(div().flex_1().h(px(1.)).bg(theme.colors.border))
        .child("Switched to");
    row = row.child(render_brand(theme, &mark.label, mark.brand.as_deref()));
    if let Some(after) = &mark.after {
        row = row.child(format!("— last one was silent for {after}"));
    }
    row.child(div().flex_1().h(px(1.)).bg(theme.colors.border))
}

fn render_brand(theme: &EmmaTheme, model: &str, provider: Option<&str>) -> Div {
    let brand = provider
        .and_then(brand_for_provider)
        .or_else(|| brand_for_model(model, None))
        .or_else(|| brand_for_model(model, Some(ModelSource::OpenRouter)));
    let data = brand_render_data(brand);
    let mut icon = div()
        .w(px(16.))
        .h(px(16.))
        .items_center()
        .justify_center()
        .text_size(theme.typography.fs_2xs)
        .text_color(if data.path.is_some() {
            theme.colors.text_2
        } else {
            theme.colors.text_3
        });
    if let Some(path) = data.path {
        icon = icon.child(img(path).w(px(16.)).h(px(16.)));
    } else {
        icon = icon.child(data.fallback);
    }
    icon
}

fn render_attachment_tray(
    attachments: &[MessageAttachment],
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    openable: bool,
) -> Div {
    let mut tray = h_flex().flex_wrap().gap_2().max_h(px(188.));
    for attachment in attachments {
        let marker = file_marker(theme, &attachment.name);
        let label = format!("{} · {}", attachment.kind.label(), attachment.name);
        let tile = v_flex()
            .items_center()
            .justify_center()
            .gap_1()
            .w(px(ATTACHMENT_TILE_SIZE))
            .h(px(ATTACHMENT_TILE_SIZE))
            .border_1()
            .border_color(theme.colors.border)
            .bg(theme.colors.surface_2)
            .child(marker)
            .child(
                div()
                    .max_w(px(ATTACHMENT_TILE_SIZE - 8.))
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(theme.typography.fs_2xs)
                    .text_color(theme.colors.text_3)
                    .child(attachment.name.clone()),
            )
            .child(if attachment.kind != AttachmentKind::Attachment {
                div()
                    .max_w(px(ATTACHMENT_TILE_SIZE - 8.))
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(theme.typography.fs_2xs)
                    .text_color(theme.colors.text_3)
                    .child(attachment.kind.label())
            } else {
                div()
            });
        if openable && attachment.path.is_some() {
            let path = attachment.path.clone().expect("attachment path is present");
            tray = tray.child(
                content_action_button(
                    &callbacks,
                    format!("attachment-{}", attachment.id),
                    label,
                    tile,
                    ConversationAction::OpenAttachment {
                        id: attachment.id.clone(),
                        path,
                    },
                    false,
                )
                .ghost()
                .small()
                .w(px(ATTACHMENT_TILE_SIZE))
                .h(px(ATTACHMENT_TILE_SIZE)),
            );
        } else {
            tray = tray.child(tile);
        }
    }
    tray
}

fn file_marker(theme: &EmmaTheme, path: &str) -> Div {
    let key = filetype_key_for_path(path).unwrap_or_else(|| {
        if filetype_asset_for_path(path).is_some() {
            "file"
        } else {
            "attachment"
        }
    });
    let mut marker = div()
        .text_size(theme.typography.fs_2xs)
        .text_color(theme.colors.text_3);
    if let Some(asset) = filetype_asset_for_path(path) {
        marker = marker.child(img(asset.path).w(px(18.)).h(px(18.)));
    } else {
        marker = marker.child(key.to_owned());
    }
    marker
}

fn render_queue(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Option<Div> {
    let mut stack = v_flex()
        .w_full()
        .max_w(px(CONTENT_COLUMN))
        .mx_auto()
        .mb_2()
        .border_1()
        .border_color(theme.colors.border)
        .bg(theme.colors.bg);
    let mut count = 0;
    if page.run.stop_confirmation || page.composer.stop_confirmation {
        count += 1;
        stack = stack.child(queue_row(
            theme,
            "Press Esc again to stop Emma",
            None,
            action_button(
                &callbacks,
                format!("keep-going-{}", page.thread_id),
                "×",
                ConversationAction::Composer(ComposerAction::KeepGoing),
                false,
            )
            .ghost()
            .small(),
        ));
    }
    for turn in &page.run.queued {
        count += 1;
        let row = queue_row(
            theme,
            &format!("Queued · {}", turn.content),
            Some(
                action_button(
                    &callbacks,
                    format!("steer-{}", turn.id),
                    "steer",
                    ConversationAction::SteerQueued(turn.id.clone()),
                    !turn.steerable,
                )
                .ghost()
                .small(),
            ),
            action_button(
                &callbacks,
                format!("drop-queued-{}", turn.id),
                "×",
                ConversationAction::DropQueued(turn.id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
        stack = stack.child(row);
    }
    for turn in &page.run.held {
        count += 1;
        let row = queue_row(
            theme,
            &format!("Held · {}", turn.content),
            Some(
                action_button(
                    &callbacks,
                    format!("release-held-{}", turn.id),
                    "↑",
                    ConversationAction::ReleaseHeld(turn.id.clone()),
                    false,
                )
                .ghost()
                .small(),
            ),
            action_button(
                &callbacks,
                format!("drop-held-{}", turn.id),
                "×",
                ConversationAction::DropHeld(turn.id.clone()),
                false,
            )
            .ghost()
            .small(),
        );
        stack = stack.child(row);
    }
    if count == 0 { None } else { Some(stack) }
}

fn queue_row(theme: &EmmaTheme, label: &str, leading: Option<Button>, trailing: Button) -> Div {
    let mut row = h_flex()
        .items_center()
        .justify_between()
        .gap_2()
        .px_2()
        .py_1()
        .text_size(theme.typography.fs_xs)
        .font_family(theme.typography.font_mono.clone())
        .text_color(theme.colors.text_2)
        .child(
            div()
                .flex_1()
                .min_w_0()
                .overflow_hidden()
                .text_ellipsis()
                .child(label.to_owned()),
        );
    if let Some(button) = leading {
        row = row.child(button);
    }
    row.child(trailing)
}

fn render_selection_toolbar(
    selection: &SelectionState,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    h_flex()
        .items_center()
        .justify_center()
        .gap_1()
        .p_1()
        .border_1()
        .border_color(theme.colors.border_strong)
        .bg(theme.colors.surface_4)
        .child(
            action_button(
                &callbacks,
                "quote-selection",
                "Add to chat",
                ConversationAction::QuoteSelection(selection.text.clone()),
                false,
            )
            .ghost()
            .small(),
        )
        .child(
            action_button(
                &callbacks,
                "new-thread-selection",
                "New thread",
                ConversationAction::NewThread(selection.text.clone()),
                false,
            )
            .ghost()
            .small()
            .border_l_1()
            .border_color(theme.colors.border),
        )
        .text_color(theme.colors.text_2)
}

fn render_composer(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
    textarea: Option<&Entity<TextareaState>>,
) -> Div {
    let composer = &page.composer;
    let busy = page.run.busy();
    let locked = composer.locked;
    let mut root = v_flex()
        .relative()
        .w_full()
        .max_w(px(CONTENT_COLUMN))
        .mx_auto()
        .mb_4()
        .border_1()
        .border_color(theme.colors.border_strong)
        .bg(theme.colors.bg);
    if let Some(draft) = composer.draft.as_deref().or(page.run.draft.as_deref()) {
        root = root.child(
            h_flex()
                .id(format!("composer-draft-{}", page.thread_id))
                .items_center()
                .justify_between()
                .gap_2()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(theme.colors.border)
                .text_color(theme.colors.text_2)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_sm)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .text_ellipsis()
                        .child(format!("Not sent · {draft}")),
                )
                .child(
                    action_button(
                        &callbacks,
                        format!("restore-draft-{}", page.thread_id),
                        "↺",
                        ConversationAction::Composer(ComposerAction::RestoreDraft),
                        locked,
                    )
                    .ghost()
                    .small(),
                ),
        );
    }
    if !composer.attachments.is_empty() {
        root = root.child(render_composer_attachments(
            composer,
            theme,
            callbacks.clone(),
        ));
    }
    let mut input_wrap = v_flex().relative().min_w_0();
    if let Some(state) = textarea {
        input_wrap = input_wrap.child(
            Textarea::new(state)
                .appearance(false)
                .bordered(false)
                .disabled(locked)
                .h(px(COMPOSER_TEXTAREA_HEIGHT))
                .aria_label("Message Emma")
                .role(Role::EditableComboBox)
                .font_family(theme.typography.font.clone())
                .text_size(theme.typography.fs_md),
        );
    } else {
        let mut fallback = v_flex()
            .id(format!("composer-fallback-{}", page.thread_id))
            .min_h(px(COMPOSER_TEXTAREA_HEIGHT))
            .p_3()
            .text_size(theme.typography.fs_md)
            .text_color(if composer.text.is_empty() {
                theme.colors.text_3
            } else {
                theme.colors.text
            });
        if composer.text.is_empty() {
            fallback = fallback.child(if busy {
                "Emma is working — Enter queues, steer on a queued line interrupts and sends it now, Esc Esc stops…"
            } else {
                "Ask Emma to continue…"
            });
        } else {
            fallback = fallback.child(render_composer_highlight(composer, theme));
        }
        input_wrap = input_wrap.child(fallback);
    }
    root = root.child(input_wrap);
    if let Some(menu) = composer
        .completion
        .as_ref()
        .filter(|_| composer.completion_active())
    {
        root = root.child(render_completion_menu(menu, theme, callbacks.clone()));
    }
    root = root.child(render_composer_row(page, theme, callbacks.clone()));
    if composer.mode_open {
        root = root.child(render_mode_menu(composer, theme, callbacks.clone()));
    }
    if composer.models_open {
        root = root.child(render_model_menu(composer, theme, callbacks.clone()));
    }
    if composer.sources_open {
        root = root.child(render_source_menu(composer, theme, callbacks));
    }
    root
}

fn render_composer_highlight(composer: &ComposerState, theme: &EmmaTheme) -> Div {
    let slash_names = composer
        .sources
        .iter()
        .chain(composer.capabilities.iter())
        .map(|item| item.name.clone())
        .collect::<Vec<_>>();
    let at_names = composer
        .sources
        .iter()
        .chain(composer.capabilities.iter())
        .map(|item| item.name.clone())
        .collect::<Vec<_>>();
    let mut body = v_flex().gap_0().whitespace_nowrap().overflow_hidden();
    for segment in composer_highlight_segments(&composer.text, &slash_names, &at_names) {
        body = body.child(
            div()
                .id(format!("composer-segment-{}", segment.id))
                .text_color(if segment.hue.is_some() {
                    theme.colors.teal
                } else {
                    theme.colors.text
                })
                .child(segment.text),
        );
    }
    body
}

fn render_composer_attachments(
    composer: &ComposerState,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let mut tray = h_flex().flex_wrap().gap_2().max_h(px(188.)).p_3();
    for attachment in &composer.attachments {
        let mut tile = v_flex()
            .id(format!("composer-tile-{}", attachment.id))
            .items_center()
            .justify_center()
            .gap_1()
            .w(px(ATTACHMENT_TILE_SIZE))
            .h(px(ATTACHMENT_TILE_SIZE))
            .border_1()
            .border_color(theme.colors.border)
            .bg(theme.colors.surface_2)
            .child(file_marker(theme, &attachment.name))
            .child(
                div()
                    .max_w(px(ATTACHMENT_TILE_SIZE - 8.))
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(theme.typography.fs_2xs)
                    .text_color(theme.colors.text_3)
                    .child(attachment.name.clone()),
            );
        if attachment.kind != AttachmentKind::Attachment {
            tile = tile.child(
                div()
                    .max_w(px(ATTACHMENT_TILE_SIZE - 8.))
                    .overflow_hidden()
                    .text_ellipsis()
                    .text_size(theme.typography.fs_2xs)
                    .text_color(theme.colors.text_3)
                    .child(attachment.kind.label()),
            );
        }
        tile = tile.child(
            action_button(
                &callbacks,
                format!("remove-attachment-{}", attachment.id),
                "×",
                ConversationAction::Composer(ComposerAction::RemoveAttachment(
                    attachment.id.clone(),
                )),
                composer.locked,
            )
            .ghost()
            .small(),
        );
        tray = tray.child(tile);
    }
    tray
}

fn render_composer_row(
    page: &ConversationPage,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let composer = &page.composer;
    let busy = page.run.busy();
    let submission = composer.submission();
    let mut row = h_flex()
        .items_center()
        .gap_1()
        .p_1()
        .border_t_1()
        .border_color(theme.colors.border);
    row = row.child(
        action_button(
            &callbacks,
            format!("source-trigger-{}", page.thread_id),
            "＋",
            if composer.sources_open {
                ConversationAction::Composer(ComposerAction::CloseSources)
            } else {
                ConversationAction::Composer(ComposerAction::OpenSources)
            },
            composer.locked,
        )
        .compact()
        .w(px(COMPOSER_CONTROL_SIZE))
        .h(px(COMPOSER_CONTROL_SIZE)),
    );
    row = row.child(
        action_button(
            &callbacks,
            format!("mode-trigger-{}", page.thread_id),
            format!("{} {}", composer.mode.glyph(), composer.mode.label()),
            ConversationAction::Composer(ComposerAction::ToggleModeMenu),
            composer.locked,
        )
        .ghost()
        .small()
        .selected(composer.mode_open),
    );
    row = row.child(div().flex_1());
    let model_label = if composer.model.label.is_empty() {
        "Select model".to_owned()
    } else {
        composer.model.label.clone()
    };
    let mut model = h_flex().items_center().gap_2();
    model = model.child(render_brand(
        theme,
        &composer.model.id,
        composer.model.brand.as_deref(),
    ));
    model = model.child(div().text_ellipsis().child(model_label));
    if let Some(route) = &composer.model.route {
        model = model.child(
            div()
                .text_size(theme.typography.fs_2xs)
                .text_color(if route == "Local" {
                    theme.colors.teal
                } else {
                    theme.colors.violet
                })
                .child(route.clone()),
        );
    }
    if let Some(effort) = &composer.model.effort {
        model = model.child(
            div()
                .text_size(theme.typography.fs_2xs)
                .text_color(theme.colors.text_3)
                .child(effort.clone()),
        );
    }
    let model_action = if composer.models_open {
        ConversationAction::Composer(ComposerAction::CloseModels)
    } else {
        ConversationAction::Composer(ComposerAction::OpenModels)
    };
    let model_callbacks = callbacks.clone();
    let model_button = Button::new(format!("model-trigger-{}", page.thread_id))
        .ghost()
        .small()
        .disabled(composer.locked)
        .selected(composer.models_open)
        .accessibility_label(format!("Select model, currently {}", composer.model.label))
        .child(model)
        .on_click(move |_, _, _| model_callbacks.emit(model_action.clone()));
    row = row.child(model_button);
    let send_action = if busy {
        if let Some(submission) = submission.clone() {
            ConversationAction::Composer(ComposerAction::Queue(submission))
        } else {
            ConversationAction::Composer(ComposerAction::Stop)
        }
    } else if let Some(submission) = submission.clone() {
        ConversationAction::Composer(ComposerAction::Send(submission))
    } else {
        ConversationAction::Composer(ComposerAction::Send(ComposerSubmission {
            text: String::new(),
            mode: composer.mode,
            model: composer.model.id.clone(),
            source: composer.source_label.clone(),
            capability: composer.capability_label.clone(),
            attachments: Vec::new(),
        }))
    };
    let send_disabled = !busy && submission.is_none();
    row.child(
        action_button(
            &callbacks,
            format!("composer-send-{}", page.thread_id),
            if busy && submission.is_none() {
                "■"
            } else {
                "↑"
            },
            send_action,
            composer.locked || send_disabled,
        )
        .compact()
        .w(px(COMPOSER_CONTROL_SIZE))
        .h(px(COMPOSER_CONTROL_SIZE)),
    )
}

fn render_completion_menu(
    menu: &CompletionMenu,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> AnyElement {
    let label = match menu.sigil {
        CompletionSigil::Slash => "Built-in tools, skills and MCP servers",
        CompletionSigil::At => "Artifacts, saved notes and files",
    };
    let mut body = v_flex()
        .gap_1()
        .max_h(px(320.))
        .p_1()
        .border_1()
        .border_color(theme.colors.border_strong)
        .bg(theme.colors.bg)
        .text_color(theme.colors.text)
        .child(div().text_size(theme.typography.fs_2xs).child(label));
    if menu.items.is_empty() {
        body = body.child(
            div()
                .p_2()
                .text_color(theme.colors.text_3)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_sm)
                .child(menu.empty_message()),
        );
    } else {
        for (index, item) in menu.items.iter().enumerate() {
            let active = index == menu.active;
            body = body.child(
                action_button(
                    &callbacks,
                    format!("slash-row-{}", item.id),
                    format!(
                        "{}{} · {} · {}",
                        menu.sigil.glyph(),
                        item.name,
                        item.kind.label(),
                        item.detail
                    ),
                    ConversationAction::Composer(ComposerAction::SelectCompletion(item.id.clone())),
                    false,
                )
                .ghost()
                .small()
                .selected(active)
                .role(Role::ListBoxOption),
            );
        }
    }
    body.id("slash-menu")
        .role(Role::ListBox)
        .aria_label(label)
        .into_any_element()
}

fn render_mode_menu(
    composer: &ComposerState,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> AnyElement {
    let mut menu = v_flex()
        .absolute()
        .bottom(px(70.))
        .left(px(4.))
        .gap_1()
        .p_2()
        .border_1()
        .border_color(theme.colors.border_strong)
        .bg(theme.colors.bg);
    for mode in PermissionMode::ALL {
        menu = menu.child(
            action_button(
                &callbacks,
                format!("permission-mode-{}", mode.id()),
                format!("{} {} — {}", mode.glyph(), mode.label(), mode.hint()),
                ConversationAction::Composer(ComposerAction::SetMode(mode)),
                composer.locked,
            )
            .ghost()
            .small()
            .selected(mode == composer.mode)
            .role(Role::MenuItem),
        );
    }
    menu.id("mode-menu")
        .role(Role::Menu)
        .aria_label("Permission modes")
        .into_any_element()
}

fn render_model_menu(
    composer: &ComposerState,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> AnyElement {
    let mut menu = v_flex()
        .absolute()
        .right(px(4.))
        .bottom(px(70.))
        .max_h(px(420.))
        .max_w(px(420.))
        .gap_1()
        .p_2()
        .border_1()
        .border_color(theme.colors.border_strong)
        .bg(theme.colors.bg);
    if composer.models.is_empty() {
        menu = menu.child(
            div()
                .p_2()
                .text_color(theme.colors.text_3)
                .child("No models available"),
        );
    } else {
        for model in &composer.models {
            let id = model.id.clone();
            let mut row = h_flex().items_center().gap_2();
            row = row.child(render_brand(theme, &model.id, model.brand.as_deref()));
            row = row.child(div().flex_1().child(model.label.clone()));
            if let Some(route) = &model.route {
                row = row.child(
                    div()
                        .text_size(theme.typography.fs_2xs)
                        .text_color(theme.colors.text_3)
                        .child(route.clone()),
                );
            }
            menu = menu.child(
                content_action_button(
                    &callbacks,
                    format!("model-option-{id}"),
                    format!("Select model {}", model.label),
                    row,
                    ConversationAction::Composer(ComposerAction::SelectModel(model.clone())),
                    composer.locked,
                )
                .ghost()
                .small()
                .selected(id == composer.model.id)
                .role(Role::MenuItem),
            );
        }
    }
    menu.id("model-menu")
        .role(Role::Menu)
        .aria_label("Models")
        .into_any_element()
}

fn render_source_menu(
    composer: &ComposerState,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> AnyElement {
    let mut menu = v_flex()
        .absolute()
        .left(px(4.))
        .bottom(px(70.))
        .max_w(px(420.))
        .max_h(px(520.))
        .border_1()
        .border_color(theme.colors.border_strong)
        .bg(theme.colors.bg)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .px_3()
                .py_2()
                .border_b_1()
                .border_color(theme.colors.border)
                .child(div().font_bold().child("Add"))
                .child(
                    action_button(
                        &callbacks,
                        "close-source-menu",
                        "×",
                        ConversationAction::Composer(ComposerAction::CloseSources),
                        composer.locked,
                    )
                    .ghost()
                    .small(),
                ),
        )
        .child(
            action_button(
                &callbacks,
                "attach-files",
                "Attach files · Images, code, CSVs, Markdown — dropping anywhere in the window or pasting works too",
                ConversationAction::Composer(ComposerAction::AttachFiles),
                composer.locked,
            )
            .ghost()
            .small(),
        )
        .child(section_label(theme, "Files"));
    if composer.sources.is_empty() {
        menu = menu.child(
            div()
                .p_3()
                .text_color(theme.colors.text_3)
                .child("Pick a folder in the project chip to list its files here."),
        );
    } else {
        for source in composer
            .sources
            .iter()
            .filter(|item| contains_query(item, &composer.source_query))
        {
            menu = menu.child(source_row(source, &callbacks, composer.locked));
        }
    }
    menu = menu.child(section_label(theme, "Skills & MCP servers"));
    if composer.capabilities.is_empty() {
        menu = menu.child(
            div()
                .p_3()
                .text_color(theme.colors.text_3)
                .child("Nothing imported yet — use /import to scan this Mac."),
        );
    } else {
        for source in composer
            .capabilities
            .iter()
            .filter(|item| contains_query(item, &composer.source_query))
        {
            menu = menu.child(source_row(source, &callbacks, composer.locked));
        }
    }
    menu = menu
        .child(
            action_button(
                &callbacks,
                "open-capabilities",
                "⌘  Imported skills & MCP · Attach a skill, or see the MCP servers every turn is handed",
                ConversationAction::Composer(ComposerAction::OpenCapabilities),
                composer.locked,
            )
            .ghost()
            .small(),
        )
        .child(section_label(theme, "Built-in plugins"))
        .child(
            action_button(
                &callbacks,
                "open-agent-runtime",
                "⌁  Agent runtime · Inspect Emma's Zig harness and headless entry point",
                ConversationAction::Composer(ComposerAction::OpenAgentRuntime),
                composer.locked,
            )
            .ghost()
            .small(),
        )
        .child(
            div()
                .p_3()
                .text_color(theme.colors.text_2)
                .child("⌥  Draw on screen · Double-tap left Option, then choose the yellow pen"),
        );
    if composer.capabilities_open {
        menu = menu.child(render_capability_panel(composer, theme, callbacks));
    }
    menu.id("source-menu")
        .role(Role::Dialog)
        .aria_label("Add context or plugin")
        .into_any_element()
}

fn render_capability_panel(
    composer: &ComposerState,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let mut panel = v_flex()
        .gap_1()
        .p_2()
        .border_t_1()
        .border_color(theme.colors.border)
        .child(
            action_button(
                &callbacks,
                "close-capabilities",
                "← Imported skills & MCP",
                ConversationAction::Composer(ComposerAction::CloseCapabilities),
                composer.locked,
            )
            .ghost()
            .small(),
        );
    for source in &composer.capabilities {
        panel = panel.child(source_row(source, &callbacks, composer.locked));
    }
    panel
}

fn source_row(source: &SourceOption, callbacks: &ConversationCallbacks, locked: bool) -> Button {
    action_button(
        callbacks,
        format!("source-row-{}", source.id),
        format!(
            "/{} · {} · {}",
            source.name,
            source.kind.label(),
            source.detail
        ),
        ConversationAction::Composer(ComposerAction::AddSource(source.id.clone())),
        locked,
    )
    .ghost()
    .small()
}

fn section_label(theme: &EmmaTheme, text: &str) -> Div {
    div()
        .px_3()
        .py_2()
        .border_t_1()
        .border_color(theme.colors.border)
        .text_size(theme.typography.fs_2xs)
        .text_color(theme.colors.text_3)
        .font_family(theme.typography.font_mono.clone())
        .child(text.to_owned())
}

fn contains_query(source: &SourceOption, query: &str) -> bool {
    let query = query.trim().to_ascii_lowercase();
    query.is_empty()
        || source.name.to_ascii_lowercase().contains(&query)
        || source.detail.to_ascii_lowercase().contains(&query)
}

fn status_message(theme: &EmmaTheme, text: &str) -> Div {
    h_flex()
        .items_center()
        .gap_2()
        .max_w(px(CONTENT_COLUMN))
        .mx_auto()
        .mt_3()
        .text_color(theme.colors.text_3)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .child("◌")
        .child(text.to_owned())
}

fn welcome_panel(theme: &EmmaTheme) -> Div {
    v_flex()
        .max_w(px(470.))
        .mx_auto()
        .mt(px(100.))
        .items_center()
        .gap_2()
        .text_center()
        .child(emma_mark(theme))
        .child(
            div()
                .text_size(theme.typography.fs_2xl)
                .font_weight(gpui::FontWeight(450.))
                .child("What are we working on?"),
        )
        .child(
            div()
                .text_size(theme.typography.fs_md)
                .text_color(theme.colors.text_2)
                .child("Ask Emma to research, plan, write, or think. Nothing enters knowledge unless you choose it."),
        )
}

fn emma_mark(theme: &EmmaTheme) -> Div {
    const ROWS: [&str; 11] = [
        ".####......####.",
        ".######..######.",
        ".##..##oo##..##.",
        ".##..##oo##..##.",
        ".##..##oo##..##.",
        ".######oo######.",
        ".####..oo..####.",
        "......####......",
        ".....##..##.....",
        "....###..###....",
        "....##....##....",
    ];
    let mut mark = v_flex().w(px(16.)).h(px(16.)).justify_center();
    for row in ROWS {
        let mut line = h_flex().h(px(1.));
        for cell in row.bytes() {
            line = line.child(div().size(px(1.)).bg(match cell {
                b'#' => theme.colors.text_3,
                b'o' => theme.colors.text_3.opacity(0.5),
                _ => theme.colors.text_3.opacity(0.),
            }));
        }
        mark = mark.child(line);
    }
    mark
}

fn error_panel(theme: &EmmaTheme, text: &str, callbacks: ConversationCallbacks) -> Div {
    v_flex()
        .gap_2()
        .max_w(px(CONTENT_COLUMN))
        .mx_auto()
        .p_4()
        .border_1()
        .border_color(theme.colors.danger)
        .text_color(theme.colors.danger)
        .child(text.to_owned())
        .child(
            div()
                .text_size(theme.typography.fs_xs)
                .text_color(theme.colors.text_2)
                .child("The request did not complete."),
        )
        .child(
            action_button(
                &callbacks,
                "retry-conversation",
                "Retry",
                ConversationAction::Retry,
                false,
            )
            .ghost()
            .small(),
        )
}

fn action_button(
    callbacks: &ConversationCallbacks,
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    action: ConversationAction,
    disabled: bool,
) -> Button {
    let callbacks = callbacks.clone();
    Button::new(id)
        .disabled(disabled)
        .label(label)
        .on_click(move |_, _, _| callbacks.emit(action.clone()))
}

fn content_action_button(
    callbacks: &ConversationCallbacks,
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    content: impl IntoElement,
    action: ConversationAction,
    disabled: bool,
) -> Button {
    let callbacks = callbacks.clone();
    Button::new(id)
        .disabled(disabled)
        .accessibility_label(label)
        .child(content)
        .on_click(move |_, _, _| callbacks.emit(action.clone()))
}

fn render_agent_panel(
    panel: &NestedAgentPanel,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    let page = ConversationPage {
        thread_id: panel.id.clone(),
        thread_title: panel.title.clone(),
        load_state: if panel.entries.is_empty() {
            ConversationLoadState::Empty
        } else {
            ConversationLoadState::Ready
        },
        entries: panel.entries.clone(),
        run: panel.run.clone(),
        ..ConversationPage::default()
    };
    v_flex()
        .size_full()
        .bg(theme.colors.bg)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .min_h(px(46.))
                .px_4()
                .child(
                    div()
                        .font_family(theme.typography.font_mono.clone())
                        .child(panel.title.clone()),
                )
                .child(
                    h_flex()
                        .items_center()
                        .gap_2()
                        .child(div().child(panel.status.label()))
                        .child(
                            action_button(
                                &callbacks,
                                format!("close-agent-{}", panel.id),
                                "×",
                                ConversationAction::CloseAgent,
                                false,
                            )
                            .ghost()
                            .small(),
                        ),
                ),
        )
        .child(render_transcript(
            &page,
            theme,
            callbacks,
            theme.dimensions.content_column,
        ))
}

pub fn render_agent_conversation(
    panel: &NestedAgentPanel,
    theme: &EmmaTheme,
    callbacks: ConversationCallbacks,
) -> Div {
    render_agent_panel(panel, theme, callbacks)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn permission_mode_contract_matches_renderer() {
        assert_eq!(PermissionMode::ALL.len(), 4);
        assert_eq!(PermissionMode::Ask.id(), "ask");
        assert_eq!(PermissionMode::AcceptEdits.label(), "Accept edits");
        assert_eq!(PermissionMode::Full.glyph(), "⬥");
    }

    #[test]
    fn markdown_parser_keeps_raw_markup_as_text() {
        let lines = markdown_lines(
            "<script>alert(1)</script>\n\n## Heading\n\n  - nested\n\n```rust\nlet x = 1;\n```",
        );
        assert_eq!(
            lines,
            vec![
                MarkdownLine::Paragraph("<script>alert(1)</script>".to_owned()),
                MarkdownLine::Heading {
                    level: 2,
                    text: "Heading".to_owned(),
                },
                MarkdownLine::Bullet {
                    ordered: false,
                    depth: 1,
                    text: "nested".to_owned(),
                },
                MarkdownLine::Code {
                    language: "rust".to_owned(),
                    text: "let x = 1;".to_owned(),
                },
            ]
        );
    }

    #[test]
    fn thinking_split_handles_complete_and_streaming_blocks() {
        assert_eq!(
            split_thinking("<think>consider it</think>answer"),
            ("consider it".to_owned(), "answer".to_owned())
        );
        assert_eq!(
            split_thinking("<think>still thinking"),
            ("still thinking".to_owned(), String::new())
        );
        assert_eq!(
            split_thinking("<thinking>still thinking</think>answer</thinking>final"),
            (
                "still thinking</think>answer".to_owned(),
                "final".to_owned()
            )
        );
    }

    #[test]
    fn thread_sender_marker_is_removed_only_when_valid() {
        assert_eq!(
            sent_by_thread("[thread abc-123 messaged]\nhello"),
            (Some("abc-123".to_owned()), "hello")
        );
        assert_eq!(
            sent_by_thread("[thread ABC messaged]\nhello"),
            (None, "[thread ABC messaged]\nhello")
        );
    }

    #[test]
    fn composer_submission_honors_ime_and_limits() {
        let mut composer = ComposerState {
            text: "hello".to_owned(),
            ..ComposerState::default()
        };
        assert_eq!(composer.submission().expect("submission").text, "hello");
        composer.composing = true;
        assert!(composer.submission().is_none());
        assert_eq!(
            composer.key_intent(ComposerKey::Enter { shift: false }),
            ComposerIntent::Ignored
        );
        composer.composing = false;
        composer.locked = true;
        assert!(composer.submission().is_none());
        composer.locked = false;
        composer.text = "x".repeat(MAX_COMPOSER_CHARS + 1);
        assert!(composer.submission().is_none());
    }

    #[test]
    fn composer_key_contract_covers_queue_and_stop() {
        let composer = ComposerState {
            text: "queued".to_owned(),
            ..ComposerState::default()
        };
        assert_eq!(
            composer.key_intent(ComposerKey::Enter { shift: false }),
            ComposerIntent::Submit
        );
        assert_eq!(
            composer.key_intent(ComposerKey::Enter { shift: true }),
            ComposerIntent::Newline
        );
        let composer = ComposerState {
            stop_confirmation: true,
            ..composer
        };
        assert_eq!(
            composer.key_intent(ComposerKey::Escape),
            ComposerIntent::Stop
        );
    }

    #[test]
    fn stall_thresholds_match_live_renderer() {
        assert!(!stalled(STALL_MS - 1, 0, false));
        assert!(stalled(STALL_MS, 0, false));
        assert!(!stalled(STALL_CALL_MS - 1, 0, true));
        assert!(stalled(STALL_CALL_MS, 0, true));
        assert_eq!(token_label(999), "999");
        assert_eq!(token_label(4_200), "4.2k");
        assert_eq!(token_label(12_000), "12k");
    }

    #[test]
    fn source_completion_empty_copy_matches_renderer() {
        let slash = CompletionMenu {
            sigil: CompletionSigil::Slash,
            query: "nope".to_owned(),
            items: Vec::new(),
            active: 0,
        };
        assert_eq!(
            slash.empty_message(),
            "Nothing matches “nope”. Built-in tools, imported skills and MCP servers appear here."
        );
    }

    #[test]
    fn tool_path_resolution_matches_file_tool_contract() {
        let from_input = ToolStep {
            id: "call".to_owned(),
            title: "Read file".to_owned(),
            kind: "read".to_owned(),
            tool_name: Some("read_file".to_owned()),
            status: StepStatus::Completed,
            input: r#"{"path":"notes/today.md"}"#.to_owned(),
            output: String::new(),
            path: None,
            edit: None,
            artifact_id: None,
            thread_id: None,
            goal_thread_id: None,
        };
        assert_eq!(from_input.resolved_path(), Some("notes/today.md"));
        let from_title = ToolStep {
            input: String::new(),
            title: "Read notes/today.md".to_owned(),
            ..from_input
        };
        assert_eq!(from_title.resolved_path(), Some("notes/today.md"));
    }
}
