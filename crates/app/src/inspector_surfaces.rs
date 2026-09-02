use std::rc::Rc;

use gpui::accesskit::Role;
use gpui::{
    AnyElement, Div, Entity, InteractiveElement as _, IntoElement, ParentElement as _, PathBuilder,
    SharedString, Stateful, StatefulInteractiveElement as _, Styled as _, canvas, div, point,
    prelude::FluentBuilder as _, px, relative,
};
use gpui_component::{
    Disableable as _, Selectable as _, Sizable as _, StyledExt as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputState, Textarea, TextareaState},
    scroll::ScrollableElement as _,
    v_flex,
};

use crate::conversation::PermissionMode;
use crate::theme::EmmaTheme;
use crate::workspace_pages::{GraphBox, edge_path, place_rows};

pub type InspectorCallback = Rc<dyn Fn(InspectorAction)>;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum InspectorStatus {
    #[default]
    Loading,
    Ready,
    Empty,
    Error(String),
    Disabled(String),
}

impl InspectorStatus {
    pub fn is_disabled(&self) -> bool {
        matches!(self, Self::Disabled(_))
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum InspectorAction {
    ToggleModeMenu,
    CloseModeMenu,
    MoveMode(isize),
    SearchMode(String),
    SelectMode(PermissionMode),
    AllowPermission {
        id: String,
        allowed: bool,
    },
    OpenAgent(String),
    StopAgent(String),
    SteerAgent {
        thread_id: String,
        text: String,
    },
    OpenBackground(String),
    StopBackground(String),
    PickTab(String),
    CloseTab(String),
    OpenThread(String),
    StopThread(String),
    SendThread {
        thread_id: String,
        text: String,
    },
    ToggleSubagents,
    OpenChange(String),
    RevertChange {
        folder_id: String,
        path: String,
        before: Option<String>,
    },
    ToggleContextLedger,
    ToggleContextLedgerRow(String),
    ToggleContextRows,
    ToggleContextCurve,
    ToggleContextAgents,
    NewContextPage,
    SelectContextPage(String),
    ToggleContextEditing,
    ToggleContextWidget(String),
    AddContextWidget(String),
    RemoveContextWidget(String),
    ReorderContextWidget {
        widget_id: String,
        before: String,
    },
    OpenSubthread(String),
    StopSubthread(String),
    OpenGit,
    OpenPlan(String),
    PickPlan(String),
    PickPlanStep {
        plan_id: String,
        step_id: String,
    },
    OpenTaskList(String),
    PickTaskList(String),
    PickTask(String),
    ToggleTimelineAxis,
    ToggleTimelineRow(String),
    PickTimelineSpan(String),
    OpenTimeline,
    PickMachine(String),
    OpenGitFile(String),
    OpenGitPath(String),
    InitializeGit(String),
    ToggleGitBranchMenu,
    SelectGitBranch(String),
    NewGitBranch {
        branch: String,
        from: String,
    },
    ToggleGitFile(String),
    ToggleAllGitFiles(bool),
    DiscardGitFiles,
    ToggleGitAmend,
    CommitGit {
        message: String,
        amend: bool,
    },
    WriteGitMessage,
    RunGit(String),
    MoreGitHistory,
    SelectGitView(String),
    FloatCli(String),
    StopCli(String),
    SendCli {
        id: String,
        prompt: String,
        attachments: Vec<String>,
    },
    AttachCli(String),
    RemoveCliAttachment(String),
    ToggleCliModels(String),
    RefreshCliModels(String),
    SelectCliModel {
        id: String,
        model: String,
    },
    RestartHarness,
    CopyHarnessFixPrompt,
    OpenHarness,
    FilterHarness(String),
    ToggleHarnessLine(String),
    PauseGoal(String),
    ResumeGoal(String),
    ContinueGoal(String),
    ClearGoal(String),
    OpenGoalThread(String),
    ToggleActivitySpan,
    OpenActivityHistory,
    OpenActivityThread(String),
    SaveModelKey {
        plan_id: String,
        secret: String,
    },
    RemoveModelKey(String),
    OpenModelKeyUrl {
        plan_id: String,
        url: String,
    },
    SignInCli(String),
    CloseCliTerminal(String),
}

#[derive(Clone)]
pub struct InspectorCallbacks {
    on_action: InspectorCallback,
}

impl InspectorCallbacks {
    pub fn new(on_action: impl Fn(InspectorAction) + 'static) -> Self {
        Self {
            on_action: Rc::new(on_action),
        }
    }

    pub fn noop() -> Self {
        Self::new(|_| {})
    }

    pub fn emit(&self, action: InspectorAction) {
        (self.on_action)(action);
    }
}

#[derive(Clone, Default)]
pub struct InspectorInputs {
    pub agent_steer: Option<Entity<TextareaState>>,
    pub thread_message: Option<Entity<InputState>>,
    pub context_page_name: Option<Entity<InputState>>,
    pub git_filter: Option<Entity<InputState>>,
    pub git_branch: Option<Entity<InputState>>,
    pub git_message: Option<Entity<TextareaState>>,
    pub git_command: Option<Entity<InputState>>,
    pub cli_message: Option<Entity<TextareaState>>,
    pub mode_search: Option<Entity<InputState>>,
    pub model_key: Option<Entity<InputState>>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentSnapshot {
    pub id: String,
    pub parent_id: Option<String>,
    pub title: String,
    pub color: String,
    pub status: String,
    pub mode: PermissionMode,
    pub model: String,
    pub effort: Option<String>,
    pub activity: String,
    pub prompt: String,
    pub tool: bool,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub steps: usize,
    pub tool_calls: usize,
    pub input_tokens: usize,
    pub output_tokens: usize,
    pub generation_ms: u64,
    pub error: Option<String>,
}

impl AgentSnapshot {
    pub fn alive(&self) -> bool {
        self.status == "running" || self.status == "waiting"
    }

    pub fn elapsed_seconds(&self, now: u64) -> u64 {
        self.ended_at.unwrap_or(now).saturating_sub(self.started_at) / 1_000
    }

    pub fn tokens_per_second(&self) -> f32 {
        if self.generation_ms == 0 {
            0.
        } else {
            self.output_tokens as f32 / (self.generation_ms as f32 / 1_000.)
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionRequest {
    pub id: String,
    pub thread_id: String,
    pub tool: String,
    pub source_title: String,
    pub mode: PermissionMode,
    pub summary: String,
    pub detail: String,
    pub focus_allow: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModePickerState {
    pub mode: PermissionMode,
    pub open: bool,
    pub active: usize,
    pub disabled: bool,
}

impl Default for ModePickerState {
    fn default() -> Self {
        Self {
            mode: PermissionMode::Ask,
            open: false,
            active: 0,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionPromptState {
    pub status: InspectorStatus,
    pub request: Option<PermissionRequest>,
    pub disabled: bool,
}

impl Default for PermissionPromptState {
    fn default() -> Self {
        Self {
            status: InspectorStatus::Empty,
            request: None,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentRailState {
    pub status: InspectorStatus,
    pub agents: Vec<AgentSnapshot>,
    pub active: Option<String>,
    pub disabled: bool,
}

impl Default for AgentRailState {
    fn default() -> Self {
        Self {
            status: InspectorStatus::Empty,
            agents: Vec::new(),
            active: None,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackgroundTaskSnapshot {
    pub id: String,
    pub command: String,
    pub folder: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub output: String,
}

impl BackgroundTaskSnapshot {
    pub fn running(&self) -> bool {
        self.status == "running"
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BackgroundRailState {
    pub status: InspectorStatus,
    pub tasks: Vec<BackgroundTaskSnapshot>,
    pub open: Option<String>,
    pub disabled: bool,
}

impl Default for BackgroundRailState {
    fn default() -> Self {
        Self {
            status: InspectorStatus::Empty,
            tasks: Vec::new(),
            open: None,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentTabSnapshot {
    pub id: String,
    pub label: String,
    pub color: Option<String>,
    pub icon: Option<String>,
    pub closable: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TabStripState {
    pub status: InspectorStatus,
    pub tabs: Vec<AgentTabSnapshot>,
    pub active: String,
    pub disabled: bool,
}

impl Default for TabStripState {
    fn default() -> Self {
        Self {
            status: InspectorStatus::Empty,
            tabs: Vec::new(),
            active: String::new(),
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TranscriptItem {
    pub id: String,
    pub role: String,
    pub text: String,
    pub status: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPanelState {
    pub status: InspectorStatus,
    pub agent: AgentSnapshot,
    pub transcript: Vec<TranscriptItem>,
    pub steer: String,
    pub now: u64,
    pub error: Option<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThreadCardState {
    pub status: InspectorStatus,
    pub id: String,
    pub title: String,
    pub agent: Option<AgentSnapshot>,
    pub message: String,
    pub sent: Option<String>,
    pub error: Option<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubagentChip {
    pub id: String,
    pub name: String,
    pub brief: String,
    pub color: String,
    pub status: String,
    pub activity: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SubagentChipsState {
    pub status: InspectorStatus,
    pub chips: Vec<SubagentChip>,
    pub done_open: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangeLine {
    pub kind: char,
    pub text: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FileChangeSnapshot {
    pub folder_id: String,
    pub path: String,
    pub before: Option<String>,
    pub after: String,
    pub added: usize,
    pub removed: usize,
    pub lines: Vec<ChangeLine>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ChangesPanelState {
    pub status: InspectorStatus,
    pub changes: Vec<FileChangeSnapshot>,
    pub busy: bool,
    pub error: Option<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextMetricSnapshot {
    pub id: String,
    pub label: String,
    pub value: String,
    pub title: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextCurvePoint {
    pub context: usize,
    pub turns: usize,
    pub rate: f32,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextLedgerRow {
    pub id: String,
    pub kind: String,
    pub label: String,
    pub chars: usize,
    pub tokens: String,
    pub share: String,
    pub turns: usize,
    pub detail: Vec<String>,
    pub expanded: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextAgentRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub activity: String,
    pub color: Option<String>,
    pub model: Option<String>,
    pub parent_id: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextThreadRow {
    pub id: String,
    pub title: String,
    pub status: String,
    pub age: String,
    pub activity: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ContextState {
    pub status: InspectorStatus,
    pub page_name: String,
    pub orientation: String,
    pub metrics: Vec<ContextMetricSnapshot>,
    pub curve: Vec<ContextCurvePoint>,
    pub curve_open: bool,
    pub total_tokens: String,
    pub capacity_tokens: Option<String>,
    pub free_tokens: Option<String>,
    pub used_share: Option<String>,
    pub rows: Vec<ContextLedgerRow>,
    pub experiments: Option<String>,
    pub agents: Vec<ContextAgentRow>,
    pub done_agents_open: bool,
    pub threads: Vec<ContextThreadRow>,
    pub git_available: bool,
    pub expanded: bool,
    pub show_all: bool,
    pub disabled: bool,
}

impl Default for ContextState {
    fn default() -> Self {
        Self {
            status: InspectorStatus::Loading,
            page_name: "Context".to_owned(),
            orientation: "vertical".to_owned(),
            metrics: Vec::new(),
            curve: Vec::new(),
            curve_open: false,
            total_tokens: "—".to_owned(),
            capacity_tokens: None,
            free_tokens: None,
            used_share: None,
            rows: Vec::new(),
            experiments: None,
            agents: Vec::new(),
            done_agents_open: false,
            threads: Vec::new(),
            git_available: false,
            expanded: false,
            show_all: false,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextWidgetSnapshot {
    pub id: String,
    pub label: String,
    pub glyph: String,
    pub orientation: String,
    pub metrics: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextSettingsState {
    pub status: InspectorStatus,
    pub pages: Vec<String>,
    pub active_page: String,
    pub page_name: String,
    pub widgets: Vec<ContextWidgetSnapshot>,
    pub spare: Vec<ContextWidgetSnapshot>,
    pub editing: bool,
    pub adding: bool,
    pub busy: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanTaskSnapshot {
    pub text: String,
    pub done: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanStepSnapshot {
    pub id: String,
    pub title: String,
    pub status: String,
    pub needs: Vec<String>,
    pub brief: String,
    pub tasks: Vec<PlanTaskSnapshot>,
    pub result: Option<String>,
    pub agent_id: Option<String>,
    pub activity: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanSnapshot {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub updated_at: String,
    pub steps: Vec<PlanStepSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PlanGraphEdge {
    pub from: String,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlanGraphNode {
    pub id: String,
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
    pub wave: usize,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PlanRailState {
    pub status: InspectorStatus,
    pub plans: Vec<PlanSnapshot>,
    pub selected_plan: Option<String>,
    pub selected_step: Option<String>,
    pub graph_nodes: Vec<PlanGraphNode>,
    pub graph_edges: Vec<PlanGraphEdge>,
    pub graph_width: f32,
    pub graph_height: f32,
    pub plan_file_open: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskSnapshot {
    pub id: String,
    pub title: String,
    pub status: String,
    pub parent_id: Option<String>,
    pub depth: usize,
    pub subtasks: Vec<TaskSnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TaskListSnapshot {
    pub id: String,
    pub title: String,
    pub goal: String,
    pub tasks: Vec<TaskSnapshot>,
    pub updated_at: String,
}

#[derive(Clone, Debug, PartialEq)]
pub struct TaskListState {
    pub status: InspectorStatus,
    pub lists: Vec<TaskListSnapshot>,
    pub selected_list: Option<String>,
    pub selected_task: Option<String>,
    pub graph_nodes: Vec<PlanGraphNode>,
    pub graph_edges: Vec<PlanGraphEdge>,
    pub graph_width: f32,
    pub graph_height: f32,
    pub file_open: bool,
    pub disabled: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TimelineAxis {
    #[default]
    Time,
    Context,
}

impl TimelineAxis {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Time => "Time",
            Self::Context => "Context",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelineSpan {
    pub id: String,
    pub parent_id: Option<String>,
    pub name: String,
    pub kind: String,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub status: String,
    pub input: Option<String>,
    pub output: Option<String>,
    pub tokens: Option<usize>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelineTurn {
    pub id: String,
    pub label: String,
    pub spans: Vec<TimelineSpan>,
    pub live: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TimelineState {
    pub status: InspectorStatus,
    pub turns: Vec<TimelineTurn>,
    pub axis: TimelineAxis,
    pub collapsed: Vec<String>,
    pub selected: Option<String>,
    pub expanded: bool,
    pub carried_tokens: usize,
    pub now: u64,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MachineSampleSnapshot {
    pub cpu: f32,
    pub memory: f32,
    pub memory_used_bytes: u64,
    pub memory_total_bytes: u64,
    pub gpu: Option<f32>,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MachineView {
    #[default]
    Stats,
    Graph,
    Meters,
}

#[derive(Clone, Debug, PartialEq)]
pub struct MachineSurfaceState {
    pub status: InspectorStatus,
    pub samples: Vec<MachineSampleSnapshot>,
    pub orientation: String,
    pub view: MachineView,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitFileSnapshot {
    pub path: String,
    pub index: String,
    pub work: String,
    pub from: Option<String>,
    pub added: usize,
    pub removed: usize,
    pub lines: Vec<ChangeLine>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitCommitSnapshot {
    pub hash: String,
    pub parents: Vec<String>,
    pub subject: String,
    pub author: String,
    pub when: u64,
    pub refs: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitSnapshotState {
    pub branch: String,
    pub head: String,
    pub upstream: String,
    pub ahead: usize,
    pub behind: usize,
    pub worktree: bool,
    pub branches: Vec<String>,
    pub remotes: Vec<String>,
    pub files: Vec<GitFileSnapshot>,
    pub diff_files: Vec<GitFileSnapshot>,
    pub truncated: bool,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum GitReadyState {
    Ready,
    NoGit,
    #[default]
    NoRepo,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPanelState {
    pub status: InspectorStatus,
    pub ready: GitReadyState,
    pub snapshot: Option<GitSnapshotState>,
    pub folder_id: Option<String>,
    pub full: bool,
    pub filter: String,
    pub excluded: Vec<String>,
    pub busy: bool,
    pub error: Option<String>,
    pub disabled: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum GitView {
    #[default]
    Changes,
    Console,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GitPageState {
    pub panel: GitPanelState,
    pub view: GitView,
    pub branch_open: bool,
    pub naming: bool,
    pub base: String,
    pub draft_branch: String,
    pub message: String,
    pub amend: bool,
    pub commits: Vec<GitCommitSnapshot>,
    pub more_history: bool,
    pub command: String,
    pub output: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliAttachment {
    pub id: String,
    pub name: String,
    pub path: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliRunState {
    pub id: String,
    pub cli: String,
    pub label: String,
    pub thread_id: String,
    pub title: String,
    pub cwd: String,
    pub folder: String,
    pub status: String,
    pub exit_code: Option<i32>,
    pub turns: usize,
    pub started_at: u64,
    pub turn_started_at: u64,
    pub ended_at: Option<u64>,
    pub unattended: bool,
    pub owns_session: bool,
    pub model: Option<String>,
    pub output: String,
    pub rich: bool,
    pub message: String,
    pub attachments: Vec<CliAttachment>,
    pub models: Vec<String>,
    pub models_at: Option<u64>,
    pub models_busy: bool,
    pub models_open: bool,
    pub error: Option<String>,
    pub busy: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarnessProcessSnapshot {
    pub cwd: String,
    pub running: bool,
    pub busy: bool,
    pub silent_ms: u64,
    pub failure: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarnessLineSnapshot {
    pub id: String,
    pub at: u64,
    pub flow: String,
    pub label: String,
    pub body: String,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HarnessFlow {
    #[default]
    All,
    Out,
    In,
    Err,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HarnessHealth {
    #[default]
    Ready,
    Online,
    Stalled,
    Offline,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarnessSurfaceState {
    pub status: InspectorStatus,
    pub health: HarnessHealth,
    pub processes: Vec<HarnessProcessSnapshot>,
    pub lines: Vec<HarnessLineSnapshot>,
    pub flow: HarnessFlow,
    pub open: bool,
    pub expanded_line: Option<String>,
    pub copied: bool,
    pub error: Option<String>,
    pub busy: bool,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalPlanStep {
    pub id: String,
    pub title: String,
    pub status: String,
    pub needs: Vec<String>,
    pub result: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalRevisionSnapshot {
    pub at: String,
    pub steps: usize,
    pub added: Vec<String>,
    pub rewritten: Vec<String>,
    pub removed: Vec<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalAgentSnapshot {
    pub id: String,
    pub title: String,
    pub color: String,
    pub status: String,
    pub activity: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct GoalSurfaceState {
    pub status: InspectorStatus,
    pub thread_id: String,
    pub objective: Option<String>,
    pub goal_status: Option<String>,
    pub token_budget: usize,
    pub tokens_used: usize,
    pub time_used_seconds: u64,
    pub turns: usize,
    pub max_turns: usize,
    pub created_at: String,
    pub evidence: Option<String>,
    pub blocked_reason: Option<String>,
    pub blocked_streak: usize,
    pub blocked_limit: usize,
    pub plan: Vec<GoalPlanStep>,
    pub revisions: Vec<GoalRevisionSnapshot>,
    pub agents: Vec<GoalAgentSnapshot>,
    pub busy: bool,
    pub error: Option<String>,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityDaySnapshot {
    pub key: String,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityProjectSnapshot {
    pub name: String,
    pub threads: usize,
    pub messages: usize,
    pub last_at: String,
    pub days: Vec<ActivityDaySnapshot>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityLineageSnapshot {
    pub id: String,
    pub title: String,
    pub meta: String,
    pub depth: usize,
    pub subagent: bool,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ActivitySpan {
    #[default]
    Week,
    Year,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivitySurfaceState {
    pub status: InspectorStatus,
    pub live_threads: usize,
    pub turns: usize,
    pub subagents: usize,
    pub streak: usize,
    pub span: ActivitySpan,
    pub history_open: bool,
    pub days: Vec<ActivityDaySnapshot>,
    pub started: Vec<ActivityDaySnapshot>,
    pub projects: Vec<ActivityProjectSnapshot>,
    pub lineage: Vec<ActivityLineageSnapshot>,
    pub disabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelPlanSnapshot {
    pub id: String,
    pub label: String,
    pub brand: String,
    pub credential_env: String,
    pub detail: String,
    pub note: String,
    pub hint: String,
    pub keys_url: String,
    pub connected: bool,
    pub key_value: String,
    pub routed_models: Vec<String>,
    pub spend_5h: Option<String>,
    pub spend_7d: Option<String>,
    pub balance: Option<String>,
    pub cli: bool,
    pub installed: bool,
    pub signed_in: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelPlansState {
    pub status: InspectorStatus,
    pub plans: Vec<ModelPlanSnapshot>,
    pub error: Option<String>,
    pub notice: Option<String>,
    pub busy: bool,
    pub disabled: bool,
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, PartialEq)]
pub enum InspectorSurface {
    Mode(ModePickerState),
    Permission(PermissionPromptState),
    AgentRail(AgentRailState),
    BackgroundRail(BackgroundRailState),
    Tabs(TabStripState),
    AgentPanel(Box<AgentPanelState>),
    ThreadCard(Box<ThreadCardState>),
    SubagentChips(Box<SubagentChipsState>),
    Changes(Box<ChangesPanelState>),
    Context(Box<ContextState>),
    ContextSettings(Box<ContextSettingsState>),
    Plan(Box<PlanRailState>),
    Tasks(Box<TaskListState>),
    Timeline(Box<TimelineState>),
    Machine(Box<MachineSurfaceState>),
    Git(Box<GitPanelState>),
    GitPage(Box<GitPageState>),
    Cli(Box<CliRunState>),
    Harness(Box<HarnessSurfaceState>),
    Goal(Box<GoalSurfaceState>),
    Activity(Box<ActivitySurfaceState>),
    ModelPlans(Box<ModelPlansState>),
}

impl InspectorSurface {
    pub fn id(&self) -> &'static str {
        match self {
            Self::Mode(_) => "mode",
            Self::Permission(_) => "permission",
            Self::AgentRail(_) => "agent-rail",
            Self::BackgroundRail(_) => "background-rail",
            Self::Tabs(_) => "tabs",
            Self::AgentPanel(_) => "agent-panel",
            Self::ThreadCard(_) => "thread-card",
            Self::SubagentChips(_) => "subagent-chips",
            Self::Changes(_) => "changes",
            Self::Context(_) => "context",
            Self::ContextSettings(_) => "context-settings",
            Self::Plan(_) => "plan",
            Self::Tasks(_) => "tasks",
            Self::Timeline(_) => "timeline",
            Self::Machine(_) => "machine",
            Self::Git(_) => "git",
            Self::GitPage(_) => "git-page",
            Self::Cli(_) => "cli",
            Self::Harness(_) => "harness",
            Self::Goal(_) => "goal",
            Self::Activity(_) => "activity",
            Self::ModelPlans(_) => "model-plans",
        }
    }

    pub fn render(
        &self,
        theme: &EmmaTheme,
        callbacks: InspectorCallbacks,
        inputs: &InspectorInputs,
    ) -> AnyElement {
        match self {
            Self::Mode(state) => render_mode(state, theme, callbacks).into_any_element(),
            Self::Permission(state) => {
                render_permission(state, theme, callbacks).into_any_element()
            }
            Self::AgentRail(state) => render_agent_rail(state, theme, callbacks).into_any_element(),
            Self::BackgroundRail(state) => {
                render_background_rail(state, theme, callbacks).into_any_element()
            }
            Self::Tabs(state) => render_tabs(state, theme, callbacks).into_any_element(),
            Self::AgentPanel(state) => {
                render_agent_panel(state, theme, callbacks, inputs).into_any_element()
            }
            Self::ThreadCard(state) => {
                render_thread_card(state, theme, callbacks, inputs).into_any_element()
            }
            Self::SubagentChips(state) => {
                render_subagent_chips(state, theme, callbacks).into_any_element()
            }
            Self::Changes(state) => render_changes(state, theme, callbacks).into_any_element(),
            Self::Context(state) => render_context(state, theme, callbacks).into_any_element(),
            Self::ContextSettings(state) => {
                render_context_settings(state, theme, callbacks, inputs).into_any_element()
            }
            Self::Plan(state) => render_plan(state, theme, callbacks).into_any_element(),
            Self::Tasks(state) => render_tasks(state, theme, callbacks).into_any_element(),
            Self::Timeline(state) => render_timeline(state, theme, callbacks).into_any_element(),
            Self::Machine(state) => render_machine(state, theme).into_any_element(),
            Self::Git(state) => {
                render_git_panel(state, theme, callbacks, inputs).into_any_element()
            }
            Self::GitPage(state) => {
                render_git_page(state, theme, callbacks, inputs).into_any_element()
            }
            Self::Cli(state) => render_cli(state, theme, callbacks, inputs).into_any_element(),
            Self::Harness(state) => render_harness(state, theme, callbacks).into_any_element(),
            Self::Goal(state) => render_goal(state, theme, callbacks).into_any_element(),
            Self::Activity(state) => render_activity(state, theme, callbacks).into_any_element(),
            Self::ModelPlans(state) => {
                render_model_plans(state, theme, callbacks, inputs).into_any_element()
            }
        }
    }
}

pub fn render_inspector_surface(
    surface: &InspectorSurface,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> AnyElement {
    surface.render(theme, callbacks, inputs)
}

fn action_button(
    callbacks: &InspectorCallbacks,
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    action: InspectorAction,
    disabled: bool,
) -> Button {
    let callbacks = callbacks.clone();
    Button::new(id)
        .ghost()
        .small()
        .disabled(disabled)
        .label(label)
        .on_click(move |_, _, _| callbacks.emit(action.clone()))
}

fn primary_button(
    callbacks: &InspectorCallbacks,
    id: impl Into<gpui::ElementId>,
    label: impl Into<SharedString>,
    action: InspectorAction,
    disabled: bool,
) -> Button {
    let callbacks = callbacks.clone();
    Button::new(id)
        .primary()
        .small()
        .disabled(disabled)
        .label(label)
        .on_click(move |_, _, _| callbacks.emit(action.clone()))
}

fn panel(theme: &EmmaTheme, title: impl Into<SharedString>) -> Stateful<Div> {
    v_flex()
        .id(format!("inspector-surface-{}", title.into()))
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s4)
        .bg(theme.colors.surface)
        .border_1()
        .border_color(theme.colors.border)
}

fn header(theme: &EmmaTheme, title: impl Into<SharedString>) -> Div {
    h_flex()
        .items_center()
        .justify_between()
        .min_h(theme.dimensions.inspector_header_height)
        .border_b_1()
        .border_color(theme.colors.border)
        .child(
            div()
                .font_family(theme.typography.font_mono.clone())
                .font_bold()
                .text_color(theme.colors.text)
                .child(title.into()),
        )
}

fn status_panel(status: &InspectorStatus, theme: &EmmaTheme) -> Option<Stateful<Div>> {
    let (mark, text, color) = match status {
        InspectorStatus::Loading => ("◌", "Loading…".to_owned(), theme.colors.text_3),
        InspectorStatus::Empty => ("·", "Nothing here yet".to_owned(), theme.colors.text_3),
        InspectorStatus::Error(error) => ("!", error.clone(), theme.colors.danger),
        InspectorStatus::Disabled(reason) => ("×", reason.clone(), theme.colors.text_3),
        InspectorStatus::Ready => return None,
    };
    Some(
        h_flex()
            .id(format!("inspector-status-{mark}"))
            .items_center()
            .gap(theme.spacing.s2)
            .text_color(color)
            .text_size(theme.typography.fs_sm)
            .role(if matches!(status, InspectorStatus::Error(_)) {
                Role::Alert
            } else {
                Role::Status
            })
            .aria_label(text.clone())
            .child(mark)
            .child(text),
    )
}

fn text_value(theme: &EmmaTheme, value: impl Into<SharedString>) -> Div {
    div()
        .min_w_0()
        .text_color(theme.colors.text)
        .text_size(theme.typography.fs_sm)
        .child(value.into())
}

fn muted(theme: &EmmaTheme, value: impl Into<SharedString>) -> Div {
    div()
        .min_w_0()
        .text_color(theme.colors.text_3)
        .text_size(theme.typography.fs_xs)
        .child(value.into())
}

fn input_value(
    state: Option<&Entity<InputState>>,
    id: impl Into<SharedString>,
    value: &str,
    label: impl Into<SharedString>,
    disabled: bool,
    theme: &EmmaTheme,
) -> AnyElement {
    let id = id.into();
    if let Some(state) = state {
        Input::new(state)
            .accessibility_id(id)
            .aria_label(label)
            .h(px(30.))
            .w_full()
            .appearance(true)
            .bordered(true)
            .focus_bordered(true)
            .disabled(disabled)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_sm)
            .into_any_element()
    } else {
        let display = if value.is_empty() {
            "Text input is unavailable".to_owned()
        } else {
            value.to_owned()
        };
        div()
            .id(id)
            .min_h(px(30.))
            .w_full()
            .px(theme.spacing.s2)
            .py(theme.spacing.s2)
            .border_1()
            .border_color(theme.colors.border_strong)
            .text_color(if value.is_empty() {
                theme.colors.text_3
            } else {
                theme.colors.text
            })
            .text_size(theme.typography.fs_sm)
            .child(display)
            .into_any_element()
    }
}

fn textarea_value(
    state: Option<&Entity<TextareaState>>,
    id: impl Into<SharedString>,
    value: &str,
    label: impl Into<SharedString>,
    height: f32,
    disabled: bool,
    theme: &EmmaTheme,
) -> AnyElement {
    let id = id.into();
    if let Some(state) = state {
        let field = Textarea::new(state)
            .aria_label(label)
            .h(px(height))
            .w_full()
            .appearance(true)
            .bordered(true)
            .disabled(disabled)
            .font_family(theme.typography.font.clone())
            .text_size(theme.typography.fs_sm);
        div().id(id).w_full().child(field).into_any_element()
    } else {
        let display = if value.is_empty() {
            "Text input is unavailable".to_owned()
        } else {
            value.to_owned()
        };
        div()
            .id(id)
            .min_h(px(height))
            .w_full()
            .p(theme.spacing.s3)
            .border_1()
            .border_color(theme.colors.border_strong)
            .text_color(if value.is_empty() {
                theme.colors.text_3
            } else {
                theme.colors.text
            })
            .text_size(theme.typography.fs_sm)
            .child(display)
            .into_any_element()
    }
}

fn mode_color(mode: PermissionMode, theme: &EmmaTheme) -> gpui::Hsla {
    match mode {
        PermissionMode::Ask => theme.colors.blue,
        PermissionMode::AcceptEdits => theme.colors.lime,
        PermissionMode::Auto => theme.colors.violet,
        PermissionMode::Full => theme.colors.accent,
    }
}

fn render_mode(
    state: &ModePickerState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-mode-picker")
        .relative()
        .gap(theme.spacing.s1);
    let trigger = action_button(
        &callbacks,
        "inspector-mode-trigger",
        format!("{} {} ▾", state.mode.glyph(), state.mode.label()),
        InspectorAction::ToggleModeMenu,
        state.disabled,
    )
    .accessibility_label(format!("Permission mode, currently {}", state.mode.label()))
    .tooltip(state.mode.hint());
    root = root.child(trigger);
    if state.open && !state.disabled {
        let mode_callbacks = callbacks.clone();
        let selected = state.mode;
        let active = state
            .active
            .min(PermissionMode::ALL.len().saturating_sub(1));
        let mut menu = v_flex()
            .id("inspector-mode-menu")
            .w(px(300.))
            .max_w(px(300.))
            .py(theme.spacing.s1)
            .bg(theme.colors.surface_3)
            .border_1()
            .border_color(theme.colors.border_strong)
            .role(Role::ListBox)
            .aria_label("Permission mode")
            .tab_index(0)
            .on_key_down(move |event, _, _| {
                let key = event.keystroke.key.as_str();
                if key == "escape" || key == "tab" {
                    mode_callbacks.emit(InspectorAction::CloseModeMenu);
                } else if key == "down" {
                    mode_callbacks.emit(InspectorAction::MoveMode(1));
                } else if key == "up" {
                    mode_callbacks.emit(InspectorAction::MoveMode(-1));
                } else if key == "home" {
                    mode_callbacks.emit(InspectorAction::MoveMode(-(active as isize)));
                } else if key == "end" {
                    mode_callbacks.emit(InspectorAction::MoveMode(
                        PermissionMode::ALL.len() as isize - 1 - active as isize,
                    ));
                } else if let Some(character) = key
                    .chars()
                    .next()
                    .filter(|character| character.is_alphabetic())
                {
                    mode_callbacks.emit(InspectorAction::SearchMode(
                        character.to_ascii_lowercase().to_string(),
                    ));
                }
            });
        for (index, mode) in PermissionMode::ALL.into_iter().enumerate() {
            let active_row = index == active;
            let callback = callbacks.clone();
            let row = Button::new(format!("inspector-mode-row-{}", mode.id()))
                .ghost()
                .small()
                .w_full()
                .justify_start()
                .selected(mode == selected)
                .role(Role::ListBoxOption)
                .tab_index(if active_row { 0 } else { -1 })
                .accessibility_label(format!("Permission mode {}", mode.label()))
                .child(
                    h_flex()
                        .w_full()
                        .items_start()
                        .gap(theme.spacing.s2)
                        .child(
                            div()
                                .text_color(mode_color(mode, theme))
                                .font_family(theme.typography.font_mono.clone())
                                .child(mode.glyph()),
                        )
                        .child(
                            v_flex()
                                .gap(theme.spacing.s1)
                                .child(text_value(theme, mode.label()))
                                .child(muted(theme, mode_meaning(mode))),
                        )
                        .when(mode == selected, |row| {
                            row.child(
                                div()
                                    .ml_auto()
                                    .text_color(theme.colors.accent)
                                    .text_size(theme.typography.fs_2xs)
                                    .child("Active"),
                            )
                        }),
                )
                .on_click(move |_, _, _| {
                    callback.emit(InspectorAction::SelectMode(mode));
                });
            menu = menu.child(row);
        }
        root = root.child(menu);
    }
    root
}

fn mode_meaning(mode: PermissionMode) -> &'static str {
    match mode {
        PermissionMode::Ask => "Request permission before making any changes",
        PermissionMode::AcceptEdits => "Edit files without asking, but ask before running anything",
        PermissionMode::Auto => "A verifier clears gated calls; app access still asks you",
        PermissionMode::Full => "Skip file and command approvals; app access still asks you",
    }
}

fn render_permission(
    state: &PermissionPromptState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = panel(theme, "permission")
        .role(Role::Dialog)
        .aria_label("Permission request");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    if let Some(request) = &state.request {
        let allow = request.focus_allow;
        let escape = callbacks.clone();
        let request_id = request.id.clone();
        root = root.on_key_down(move |event, _, _| {
            if event.keystroke.key == "escape" {
                escape.emit(InspectorAction::AllowPermission {
                    id: request_id.clone(),
                    allowed: false,
                });
            }
        });
        let title = if request.source_title.is_empty() {
            "Emma".to_owned()
        } else {
            request.source_title.clone()
        };
        root = root
            .child(
                h_flex()
                    .items_start()
                    .justify_between()
                    .gap(theme.spacing.s3)
                    .child(
                        v_flex()
                            .gap(theme.spacing.s1)
                            .child(muted(
                                theme,
                                format!("{} · {}", title, request.mode.label()),
                            ))
                            .child(
                                div()
                                    .text_size(theme.typography.fs_lg)
                                    .font_bold()
                                    .child(request.summary.clone()),
                            ),
                    )
                    .child(div().w(px(8.)).h(px(8.)).rounded(theme.radii.full).bg(
                        if request.tool == "computer" {
                            theme.colors.yellow
                        } else {
                            theme.colors.accent
                        },
                    )),
            )
            .child(
                div()
                    .p(theme.spacing.s3)
                    .bg(theme.colors.surface_2)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_xs)
                    .child(request.detail.clone()),
            )
            .child(
                h_flex()
                    .justify_end()
                    .gap(theme.spacing.s2)
                    .child(action_button(
                        &callbacks,
                        format!("permission-deny-{}", request.id),
                        "Don’t",
                        InspectorAction::AllowPermission {
                            id: request.id.clone(),
                            allowed: false,
                        },
                        state.disabled,
                    ))
                    .child(primary_button(
                        &callbacks,
                        format!("permission-allow-{}", request.id),
                        if allow {
                            "Allow for this turn"
                        } else {
                            "Allow once"
                        },
                        InspectorAction::AllowPermission {
                            id: request.id.clone(),
                            allowed: true,
                        },
                        state.disabled,
                    )),
            );
    }
    root
}

fn render_agent_rail(
    state: &AgentRailState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let live: Vec<&AgentSnapshot> = state.agents.iter().filter(|agent| agent.alive()).collect();
    let mut root = v_flex()
        .id("inspector-agent-rail")
        .w_full()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .border_b_1()
        .border_color(theme.colors.border);
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    if !live.is_empty() {
        root = root.child(
            muted(theme, format!("Agents · {}", live.len()))
                .font_family(theme.typography.font_mono.clone()),
        );
        let roots = live
            .iter()
            .copied()
            .filter(|agent| {
                !live
                    .iter()
                    .any(|other| other.id == agent.parent_id.clone().unwrap_or_default())
            })
            .collect::<Vec<_>>();
        for agent in roots {
            root = root.child(render_agent_branch(
                agent,
                &live,
                state.active.as_deref(),
                state.disabled,
                theme,
                &callbacks,
                0,
            ));
        }
    }
    root
}

fn render_agent_branch(
    agent: &AgentSnapshot,
    all: &[&AgentSnapshot],
    active: Option<&str>,
    disabled: bool,
    theme: &EmmaTheme,
    callbacks: &InspectorCallbacks,
    depth: usize,
) -> Div {
    let selected = active == Some(agent.id.as_str());
    let callback = callbacks.clone();
    let agent_id = agent.id.clone();
    let mut row = Button::new(format!("agent-rail-{}", agent.id))
        .ghost()
        .small()
        .w_full()
        .justify_start()
        .selected(selected)
        .disabled(disabled)
        .accessibility_label(format!("{} — {}", agent.title, agent.activity))
        .child(
            h_flex()
                .w_full()
                .items_center()
                .gap(theme.spacing.s2)
                .pl(px(depth as f32 * 10.))
                .child(
                    div()
                        .w(px(8.))
                        .h(px(8.))
                        .rounded(theme.radii.full)
                        .bg(agent_color(agent, theme)),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .child(text_value(theme, agent.title.clone()))
                        .child(muted(theme, agent.activity.clone())),
                ),
        )
        .on_click(move |_, _, _| callback.emit(InspectorAction::OpenAgent(agent_id.clone())));
    if agent.tool {
        row = row.tooltip("tool call in flight");
    }
    let mut branch = v_flex().w_full().child(row);
    let children = all
        .iter()
        .copied()
        .filter(|child| child.parent_id.as_deref() == Some(agent.id.as_str()))
        .collect::<Vec<_>>();
    if !children.is_empty() {
        let mut child_rows = v_flex().w_full().gap(theme.spacing.s1);
        for child in children {
            child_rows = child_rows.child(render_agent_branch(
                child,
                all,
                active,
                disabled,
                theme,
                callbacks,
                depth + 1,
            ));
        }
        branch = branch.child(child_rows);
    }
    branch
}

fn agent_color(agent: &AgentSnapshot, theme: &EmmaTheme) -> gpui::Hsla {
    let fallback = match agent.status.as_str() {
        "running" => theme.colors.teal,
        "waiting" => theme.colors.yellow,
        "failed" => theme.colors.danger,
        "stopped" => theme.colors.text_3,
        _ => theme.colors.lime,
    };
    parse_hex_color(&agent.color, fallback)
}

fn render_background_rail(
    state: &BackgroundRailState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let running = state.tasks.iter().filter(|task| task.running()).count();
    let mut root = v_flex()
        .id("inspector-background-rail")
        .w_full()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .border_b_1()
        .border_color(theme.colors.border);
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    if !state.tasks.is_empty() {
        root = root.child(muted(theme, format!("Background · {}", running)));
    }
    for task in &state.tasks {
        let open = state.open.as_deref() == Some(task.id.as_str());
        let callback = callbacks.clone();
        let task_id = task.id.clone();
        let mut row = h_flex()
            .w_full()
            .items_center()
            .gap(theme.spacing.s2)
            .child(
                Button::new(format!("background-open-{}", task.id))
                    .ghost()
                    .small()
                    .flex_1()
                    .justify_start()
                    .selected(open)
                    .accessibility_label(format!("{} — {}", task.command, task.id))
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(text_value(
                                theme,
                                task.command.lines().next().unwrap_or("background command"),
                            ))
                            .child(muted(
                                theme,
                                if task.running() {
                                    format!("{} · running", task.folder)
                                } else {
                                    format!(
                                        "{} · exit {}",
                                        task.id,
                                        task.exit_code
                                            .map(|code| code.to_string())
                                            .unwrap_or_else(|| "—".to_owned())
                                    )
                                },
                            )),
                    )
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::OpenBackground(task_id.clone()))
                    }),
            );
        if task.running() {
            let stop = callbacks.clone();
            row = row.child(
                action_button(
                    &stop,
                    format!("background-stop-{}", task.id),
                    "Stop",
                    InspectorAction::StopBackground(task.id.clone()),
                    state.disabled,
                )
                .accessibility_label(format!("Stop {}", task.id)),
            );
        }
        root = root.child(row);
        if open {
            root = root.child(
                div()
                    .id(format!("background-output-{}", task.id))
                    .max_h(px(180.))
                    .w_full()
                    .overflow_y_scrollbar()
                    .p(theme.spacing.s2)
                    .bg(theme.colors.surface_2)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_2xs)
                    .child(if task.output.trim().is_empty() {
                        "(no output yet)".to_owned()
                    } else {
                        task.output.trim().to_owned()
                    }),
            );
        }
    }
    root
}

fn render_tabs(
    state: &TabStripState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    if state.tabs.len() < 2 && state.tabs.iter().any(|tab| tab.id == state.active) {
        return div().id("inspector-tabs-empty");
    }
    let mut root = h_flex()
        .id("inspector-tab-strip")
        .w_full()
        .gap(theme.spacing.s1)
        .role(Role::TabList)
        .aria_label("Thread tabs");
    for tab in &state.tabs {
        let active = tab.id == state.active;
        let pick = callbacks.clone();
        let tab_id = tab.id.clone();
        let mut group = h_flex().items_center().gap(theme.spacing.s1).child(
            Button::new(format!("inspector-tab-{}", tab.id))
                .ghost()
                .small()
                .selected(active)
                .role(Role::Tab)
                .accessibility_label(tab.label.clone())
                .child(
                    h_flex()
                        .items_center()
                        .gap(theme.spacing.s1)
                        .when_some(tab.color.clone(), |row, color| {
                            row.child(
                                div()
                                    .w(px(7.))
                                    .h(px(7.))
                                    .rounded(theme.radii.full)
                                    .bg(parse_hex_color(&color, theme.colors.accent)),
                            )
                        })
                        .child(tab.label.clone()),
                )
                .on_click(move |_, _, _| pick.emit(InspectorAction::PickTab(tab_id.clone()))),
        );
        if tab.closable {
            let close = callbacks.clone();
            group = group.child(
                action_button(
                    &close,
                    format!("inspector-tab-close-{}", tab.id),
                    "×",
                    InspectorAction::CloseTab(tab.id.clone()),
                    state.disabled,
                )
                .accessibility_label(format!("Close {}", tab.label)),
            );
        }
        root = root.child(group);
    }
    root
}

fn parse_hex_color(value: &str, fallback: gpui::Hsla) -> gpui::Hsla {
    let value = value.trim().trim_start_matches('#');
    if value.len() != 6 {
        return fallback;
    }
    let Ok(rgb) = u32::from_str_radix(value, 16) else {
        return fallback;
    };
    gpui::rgb(rgb).into()
}

fn render_agent_panel(
    state: &AgentPanelState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let agent = &state.agent;
    let locked = state.disabled || !agent.alive();
    let mut root = v_flex()
        .id(format!("agent-panel-{}", agent.id))
        .size_full()
        .min_w_0()
        .bg(theme.colors.bg)
        .text_color(theme.colors.text)
        .gap(theme.spacing.s3)
        .role(Role::Region)
        .aria_label(format!("Subagent: {}", agent.title));
    let mut bar = h_flex()
        .flex_none()
        .items_center()
        .justify_between()
        .min_h(theme.dimensions.thread_bar_height)
        .px(theme.spacing.s4)
        .border_b_1()
        .border_color(theme.colors.border);
    bar = bar.child(
        h_flex()
            .items_center()
            .gap(theme.spacing.s2)
            .child(
                div()
                    .w(px(8.))
                    .h(px(8.))
                    .rounded(theme.radii.full)
                    .bg(agent_color(agent, theme)),
            )
            .child(
                div()
                    .font_family(theme.typography.font_mono.clone())
                    .font_bold()
                    .child(agent.title.clone()),
            ),
    );
    let mut actions = h_flex().items_center().gap(theme.spacing.s2).child(
        div()
            .text_color(agent_color(agent, theme))
            .text_size(theme.typography.fs_xs)
            .child(agent.status.clone()),
    );
    if agent.alive() {
        actions = actions.child(action_button(
            &callbacks,
            format!("agent-stop-{}", agent.id),
            "Stop",
            InspectorAction::StopAgent(agent.id.clone()),
            state.disabled,
        ));
    }
    bar = bar.child(actions);
    root = root.child(bar);
    root = root.child(render_agent_stats(agent, state.now, theme));
    if let Some(error) = &agent.error {
        root = root.child(
            div()
                .id(format!("agent-error-{}", agent.id))
                .px(theme.spacing.s4)
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .aria_label(error.clone())
                .child(error.clone()),
        );
    }
    let mut transcript = v_flex()
        .id(format!("agent-transcript-{}", agent.id))
        .flex_1()
        .min_h_0()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s4)
        .overflow_y_scrollbar();
    if let Some(status) = status_panel(&state.status, theme) {
        transcript = transcript.child(status);
    }
    if state.transcript.is_empty() {
        transcript = transcript.child(muted(theme, "Waiting for this agent’s first turn…"));
    }
    for item in &state.transcript {
        let color = match item.role.as_str() {
            "user" => theme.colors.accent,
            "system" => theme.colors.yellow,
            _ => theme.colors.text,
        };
        let mut message = v_flex()
            .id(format!("agent-transcript-item-{}", item.id))
            .gap(theme.spacing.s1)
            .max_w(theme.dimensions.content_column)
            .mx_auto()
            .w_full()
            .child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(div().text_color(color).font_bold().child(item.role.clone()))
                    .when_some(item.status.clone(), |row, status| {
                        row.child(muted(theme, status))
                    }),
            )
            .child(
                div()
                    .text_color(theme.colors.text)
                    .text_size(theme.typography.fs_md)
                    .child(item.text.clone()),
            );
        if item.text.is_empty() {
            message = message.child(muted(theme, "(empty turn)"));
        }
        transcript = transcript.child(message);
    }
    root = root.child(transcript);
    let steer_placeholder = if agent.alive() {
        "Steer this agent — delivered with its next tool result"
    } else {
        "This agent has finished"
    };
    let steer = textarea_value(
        inputs.agent_steer.as_ref(),
        format!("agent-steer-{}", agent.id),
        &state.steer,
        "Steer this agent",
        64.,
        locked,
        theme,
    );
    let mut composer = v_flex()
        .id(format!("agent-steer-composer-{}", agent.id))
        .flex_none()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s4)
        .border_t_1()
        .border_color(theme.colors.border)
        .child(steer);
    if inputs.agent_steer.is_none() && state.steer.is_empty() {
        composer = composer.child(muted(theme, steer_placeholder));
    }
    composer = composer.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(muted(theme, "Steering never interrupts a call in flight."))
            .child(primary_button(
                &callbacks,
                format!("agent-steer-send-{}", agent.id),
                "↑",
                InspectorAction::SteerAgent {
                    thread_id: agent.id.clone(),
                    text: state.steer.trim().to_owned(),
                },
                locked || state.steer.trim().is_empty(),
            )),
    );
    if let Some(error) = &state.error {
        composer = composer.child(
            div()
                .id(format!("agent-steer-error-{}", agent.id))
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    root.child(composer)
}

fn render_agent_stats(agent: &AgentSnapshot, now: u64, theme: &EmmaTheme) -> Stateful<Div> {
    let model = agent
        .model
        .rsplit(':')
        .next()
        .unwrap_or(&agent.model)
        .rsplit('/')
        .next()
        .unwrap_or("—");
    let thinking = agent.effort.as_deref().unwrap_or("—");
    let speed = agent.tokens_per_second();
    let mut grid = v_flex()
        .id(format!("agent-stats-{}", agent.id))
        .gap(theme.spacing.s2)
        .px(theme.spacing.s4);
    let cells = [
        ("Model", model.to_owned()),
        ("Thinking", thinking.to_owned()),
        ("Mode", agent.mode.label().to_owned()),
        (
            "Speed",
            if speed > 0. {
                format!("{speed:.1} tok/s")
            } else {
                "—".to_owned()
            },
        ),
        (
            "Tokens",
            format!("{} in · {} out", agent.input_tokens, agent.output_tokens),
        ),
        ("Tool calls", agent.tool_calls.to_string()),
        ("Steps", format!("{} of the turn", agent.steps)),
        ("Elapsed", format!("{} seconds", agent.elapsed_seconds(now))),
    ];
    let cell_count = cells.len();
    let mut row = h_flex().w_full().gap(theme.spacing.s2);
    for (index, (label, value)) in cells.into_iter().enumerate() {
        row = row.child(
            v_flex()
                .id(format!("agent-stat-{}-{}", agent.id, index))
                .flex_1()
                .min_w(px(120.))
                .gap(theme.spacing.s1)
                .child(muted(theme, label))
                .child(text_value(theme, value)),
        );
        if (index + 1).is_multiple_of(4) {
            grid = grid.child(row);
            row = h_flex().w_full().gap(theme.spacing.s2);
        }
    }
    if !cell_count.is_multiple_of(4) {
        grid = grid.child(row);
    }
    grid.child(
        h_flex()
            .gap(theme.spacing.s2)
            .child(muted(theme, "Doing"))
            .child(text_value(theme, agent.activity.clone())),
    )
}

fn render_thread_card(
    state: &ThreadCardState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let live = state.agent.as_ref().is_some_and(AgentSnapshot::alive);
    let status = state
        .agent
        .as_ref()
        .map(|agent| agent.status.clone())
        .unwrap_or_else(|| "idle".to_owned());
    let activity = state
        .agent
        .as_ref()
        .map(|agent| agent.activity.clone())
        .filter(|text| !text.is_empty())
        .unwrap_or_else(|| "Nothing is running in this thread.".to_owned());
    let mut root = v_flex()
        .id(format!("thread-card-{}", state.id))
        .w_full()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .bg(theme.colors.surface_2)
        .border_1()
        .border_color(theme.colors.border);
    let mut title = h_flex()
        .items_center()
        .gap(theme.spacing.s2)
        .child(
            div().w(px(8.)).h(px(8.)).rounded(theme.radii.full).bg(state
                .agent
                .as_ref()
                .map(|agent| agent_color(agent, theme))
                .unwrap_or(theme.colors.text_3)),
        )
        .child(
            div()
                .flex_1()
                .min_w_0()
                .text_color(theme.colors.text)
                .font_bold()
                .child(state.title.clone()),
        )
        .child(muted(theme, status));
    title = title.child(action_button(
        &callbacks,
        format!("thread-card-open-{}", state.id),
        "Open",
        InspectorAction::OpenThread(state.id.clone()),
        state.disabled,
    ));
    if live {
        title = title.child(action_button(
            &callbacks,
            format!("thread-card-stop-{}", state.id),
            "Stop",
            InspectorAction::StopThread(state.id.clone()),
            state.disabled,
        ));
    }
    root = root.child(title).child(muted(theme, activity));
    let field = input_value(
        inputs.thread_message.as_ref(),
        format!("thread-card-input-{}", state.id),
        &state.message,
        format!("Message {}", state.title),
        state.disabled,
        theme,
    );
    root = root.child(
        h_flex()
            .items_center()
            .gap(theme.spacing.s2)
            .child(field)
            .child(primary_button(
                &callbacks,
                format!("thread-card-send-{}", state.id),
                "Send",
                InspectorAction::SendThread {
                    thread_id: state.id.clone(),
                    text: state.message.trim().to_owned(),
                },
                state.disabled || state.message.trim().is_empty(),
            )),
    );
    if let Some(sent) = &state.sent {
        root = root.child(muted(theme, sent.clone()));
    }
    if let Some(error) = &state.error {
        root = root.child(
            div()
                .id(format!("thread-card-error-{}", state.id))
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    root
}

fn render_subagent_chips(
    state: &SubagentChipsState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let live = state
        .chips
        .iter()
        .filter(|chip| chip.status == "running" || chip.status == "waiting")
        .collect::<Vec<_>>();
    let done = state
        .chips
        .iter()
        .filter(|chip| chip.status != "running" && chip.status != "waiting")
        .collect::<Vec<_>>();
    let mut root = v_flex()
        .id("inspector-subagent-chips")
        .w_full()
        .gap(theme.spacing.s2)
        .role(Role::List)
        .aria_label(format!("{} subagents", state.chips.len()));
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let live_count = live.len();
    let mut rows = h_flex().w_full().gap(theme.spacing.s2);
    for chip in live {
        rows = rows.child(render_chip(chip, theme, &callbacks, state.disabled));
    }
    if live_count > 0 {
        root = root.child(rows);
    }
    if !done.is_empty() {
        let mut finished = v_flex().w_full().gap(theme.spacing.s2);
        let toggle = action_button(
            &callbacks,
            "inspector-subagents-done",
            format!("{} finished", done.len()),
            InspectorAction::ToggleSubagents,
            state.disabled,
        )
        .accessibility_label(format!("{} finished subagents", done.len()));
        finished = finished.child(toggle);
        if state.done_open {
            let mut done_rows = h_flex().w_full().gap(theme.spacing.s2);
            for chip in done {
                done_rows = done_rows.child(render_chip(chip, theme, &callbacks, state.disabled));
            }
            finished = finished.child(done_rows);
        }
        root = root.child(finished);
    }
    if state.chips.is_empty() {
        root = root.child(muted(
            theme,
            "Nothing delegated yet — a subagent gets a row here the moment it starts.",
        ));
    }
    root
}

fn render_chip(
    chip: &SubagentChip,
    theme: &EmmaTheme,
    callbacks: &InspectorCallbacks,
    disabled: bool,
) -> Button {
    let callback = callbacks.clone();
    let chip_id = chip.id.clone();
    let mut label = chip.name.clone();
    if let Some(activity) = chip.activity.as_deref().filter(|text| !text.is_empty()) {
        label.push_str(" · ");
        label.push_str(activity);
    } else if !chip.brief.is_empty() {
        label.push_str(" · ");
        label.push_str(&chip.brief);
    }
    Button::new(format!("inspector-subagent-chip-{}", chip.id))
        .ghost()
        .small()
        .disabled(disabled)
        .accessibility_label(label.clone())
        .tooltip(label)
        .child(
            h_flex()
                .items_center()
                .gap(theme.spacing.s2)
                .child(
                    div()
                        .w(px(8.))
                        .h(px(8.))
                        .bg(parse_hex_color(&chip.color, theme.colors.accent)),
                )
                .child(chip.name.clone())
                .when_some(chip.activity.clone(), |row, activity| {
                    row.child(muted(theme, activity))
                }),
        )
        .on_click(move |_, _, _| callback.emit(InspectorAction::OpenAgent(chip_id.clone())))
}

fn render_changes(
    state: &ChangesPanelState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let added = state
        .changes
        .iter()
        .map(|change| change.added)
        .sum::<usize>();
    let removed = state
        .changes
        .iter()
        .map(|change| change.removed)
        .sum::<usize>();
    let mut root = v_flex()
        .id("inspector-changes")
        .size_full()
        .min_w_0()
        .bg(theme.colors.bg)
        .role(Role::Region)
        .aria_label("Changes");
    root = root.child(
        header(theme, "Changes").child(
            h_flex()
                .items_center()
                .gap(theme.spacing.s2)
                .child(change_count(theme, added, removed)),
        ),
    );
    if let Some(error) = &state.error {
        root = root.child(
            div()
                .id(format!("changes-error-{}", state.changes.len()))
                .p(theme.spacing.s3)
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    let mut body = v_flex()
        .id("inspector-changes-body")
        .flex_1()
        .min_h_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s4)
        .overflow_y_scrollbar();
    if let Some(status) = status_panel(&state.status, theme) {
        body = body.child(status);
    }
    if state.changes.is_empty() {
        body = body.child(muted(
            theme,
            "Nothing has been written from this thread yet.",
        ));
    }
    for change in state.changes.iter().rev() {
        let mut row = v_flex()
            .id(format!("change-{}-{}", change.folder_id, change.path))
            .gap(theme.spacing.s2)
            .p(theme.spacing.s3)
            .border_1()
            .border_color(theme.colors.border)
            .child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_color(theme.colors.text)
                            .child(change.path.clone()),
                    )
                    .child(change_count(theme, change.added, change.removed))
                    .child(action_button(
                        &callbacks,
                        format!("change-open-{}", change.path),
                        "Open",
                        InspectorAction::OpenChange(change.path.clone()),
                        state.disabled,
                    )),
            );
        let mut diff = v_flex()
            .id(format!("change-diff-{}", change.path))
            .max_h(px(320.))
            .overflow_y_scrollbar()
            .p(theme.spacing.s2)
            .bg(theme.colors.surface_2)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_2xs);
        if change.lines.is_empty() {
            diff = diff.child(change.after.clone());
        } else {
            for (index, line) in change.lines.iter().enumerate() {
                let color = match line.kind {
                    '+' => theme.colors.lime,
                    '-' => theme.colors.rose,
                    _ => theme.colors.text_2,
                };
                diff = diff.child(
                    div()
                        .id(format!("change-line-{}-{}", change.path, index))
                        .text_color(color)
                        .child(format!("{}{}", line.kind, line.text)),
                );
            }
        }
        row = row.child(diff);
        let can_revert = change.before.is_some() && !state.busy && !state.disabled;
        row = row.child(h_flex().justify_end().child(action_button(
            &callbacks,
            format!("change-revert-{}", change.path),
            "Revert",
            InspectorAction::RevertChange {
                folder_id: change.folder_id.clone(),
                path: change.path.clone(),
                before: change.before.clone(),
            },
            !can_revert,
        )));
        body = body.child(row);
    }
    root.child(body)
}

fn change_count(theme: &EmmaTheme, added: usize, removed: usize) -> Div {
    h_flex()
        .gap(theme.spacing.s2)
        .text_size(theme.typography.fs_xs)
        .child(
            div()
                .text_color(theme.colors.lime)
                .child(format!("+{added}")),
        )
        .child(
            div()
                .text_color(theme.colors.rose)
                .child(format!("-{removed}")),
        )
}

fn render_context(
    state: &ContextState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-context")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Context inspector");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let mut title = h_flex()
        .items_center()
        .justify_between()
        .child(
            v_flex()
                .gap(theme.spacing.s1)
                .child(text_value(theme, state.page_name.clone()))
                .child(muted(theme, "Context window")),
        )
        .child(action_button(
            &callbacks,
            "context-expand",
            "Expand",
            InspectorAction::ToggleContextLedger,
            state.disabled,
        ));
    if state.expanded {
        title = title.child(muted(theme, "expanded"));
    }
    root = root.child(title);
    let usage = match (&state.capacity_tokens, &state.used_share) {
        (Some(capacity), Some(share)) => {
            format!("{} / {} tokens ({share})", state.total_tokens, capacity)
        }
        _ => format!("{} tokens sent · no stated window", state.total_tokens),
    };
    root = root.child(
        v_flex()
            .gap(theme.spacing.s1)
            .p(theme.spacing.s3)
            .bg(theme.colors.surface_2)
            .child(text_value(theme, usage))
            .when_some(state.free_tokens.clone(), |body, free| {
                body.child(muted(theme, format!("{free} free")))
            }),
    );
    if !state.metrics.is_empty() {
        let mut metrics = v_flex().gap(theme.spacing.s2);
        let mut row = h_flex().w_full().gap(theme.spacing.s2);
        for (index, metric) in state.metrics.iter().enumerate() {
            let mut cell = v_flex()
                .id(format!("context-metric-{}", metric.id))
                .flex_1()
                .min_w(px(92.))
                .gap(theme.spacing.s1)
                .child(muted(theme, metric.label.clone()))
                .child(text_value(theme, metric.value.clone()));
            if let Some(title) = metric.title.clone() {
                cell = cell.aria_label(title);
            }
            row = row.child(cell);
            if (index + 1).is_multiple_of(3) {
                metrics = metrics.child(row);
                row = h_flex().w_full().gap(theme.spacing.s2);
            }
        }
        if !state.metrics.len().is_multiple_of(3) {
            metrics = metrics.child(row);
        }
        root = root.child(metrics);
    }
    if !state.curve.is_empty() {
        let mut curve = v_flex().gap(theme.spacing.s1);
        let peak = state
            .curve
            .iter()
            .map(|point| point.rate)
            .fold(1., f32::max);
        curve = curve.child(action_button(
            &callbacks,
            "context-rate-toggle",
            if state.curve_open {
                "Hide throughput curve"
            } else {
                "Tokens a second by context size"
            },
            InspectorAction::ToggleContextCurve,
            state.disabled,
        ));
        if state.curve_open {
            for (index, point) in state.curve.iter().enumerate() {
                curve = curve.child(
                    h_flex()
                        .id(format!("context-curve-{index}"))
                        .items_center()
                        .gap(theme.spacing.s2)
                        .child(muted(theme, format!("{}K", point.context / 1024)))
                        .child(
                            div()
                                .relative()
                                .h(px(6.))
                                .flex_1()
                                .bg(theme.colors.surface_3)
                                .child(
                                    div()
                                        .absolute()
                                        .left_0()
                                        .h(px(6.))
                                        .w(relative((point.rate / peak).clamp(0., 1.)))
                                        .bg(theme.colors.teal),
                                ),
                        )
                        .child(text_value(
                            theme,
                            format!("{}", point.rate.round() as usize),
                        )),
                );
            }
        }
        root = root.child(curve);
    }
    if !state.rows.is_empty() {
        let limit = if state.show_all {
            state.rows.len()
        } else {
            state.rows.len().min(3)
        };
        let mut rows = v_flex()
            .id("context-ledger-rows")
            .gap(theme.spacing.s1)
            .role(Role::List);
        for item in state.rows.iter().take(limit) {
            let callback = callbacks.clone();
            let row_id = item.id.clone();
            let selected = item.expanded;
            rows = rows.child(
                Button::new(format!("context-row-{}", item.id))
                    .ghost()
                    .small()
                    .w_full()
                    .justify_start()
                    .selected(selected)
                    .role(Role::ListItem)
                    .accessibility_label(format!(
                        "{} · {} · {} · {} turns",
                        item.label, item.tokens, item.share, item.turns
                    ))
                    .child(
                        h_flex()
                            .w_full()
                            .gap(theme.spacing.s2)
                            .child(
                                div()
                                    .w(px(8.))
                                    .h(px(8.))
                                    .bg(context_kind_color(&item.kind, theme)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(text_value(theme, item.label.clone()))
                                    .child(muted(
                                        theme,
                                        format!("{} chars · {} turns", item.chars, item.turns),
                                    )),
                            )
                            .child(text_value(theme, item.tokens.clone()))
                            .child(muted(theme, item.share.clone())),
                    )
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::ToggleContextLedgerRow(row_id.clone()))
                    }),
            );
            if item.expanded {
                let mut detail = v_flex()
                    .id(format!("context-detail-{}", item.id))
                    .gap(theme.spacing.s1)
                    .pl(px(20.))
                    .pb(theme.spacing.s2);
                for entry in &item.detail {
                    detail = detail.child(muted(theme, entry.clone()));
                }
                rows = rows.child(detail);
            }
        }
        if state.rows.len() > 3 {
            root = root.child(action_button(
                &callbacks,
                "context-more",
                if state.show_all { "Less" } else { "More" },
                InspectorAction::ToggleContextRows,
                state.disabled,
            ));
        }
        root = root.child(rows);
    }
    if let Some(experiments) = &state.experiments {
        root = root.child(muted(theme, format!("Experiments · {experiments}")));
    }
    if state.expanded {
        let mut ledger = panel(theme, "context-ledger")
            .role(Role::Dialog)
            .aria_label("Context ledger")
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(text_value(theme, "Context ledger"))
                    .child(action_button(
                        &callbacks,
                        "context-ledger-close",
                        "Close",
                        InspectorAction::ToggleContextLedger,
                        state.disabled,
                    )),
            )
            .child(text_value(
                theme,
                match (&state.capacity_tokens, &state.used_share) {
                    (Some(capacity), Some(share)) => {
                        format!("{} / {} tokens ({share})", state.total_tokens, capacity)
                    }
                    _ => format!("{} tokens carried · no stated window", state.total_tokens),
                },
            ));
        if state.rows.is_empty() {
            ledger = ledger.child(muted(theme, "No context segments measured yet."));
        } else {
            for row in &state.rows {
                let mut item = v_flex()
                    .id(format!("context-ledger-detail-{}", row.id))
                    .gap(theme.spacing.s1)
                    .p(theme.spacing.s2)
                    .border_b_1()
                    .border_color(theme.colors.border)
                    .child(
                        h_flex()
                            .items_center()
                            .gap(theme.spacing.s2)
                            .child(
                                div()
                                    .w(px(7.))
                                    .h(px(7.))
                                    .rounded(theme.radii.full)
                                    .bg(context_kind_color(&row.kind, theme)),
                            )
                            .child(text_value(theme, row.label.clone()))
                            .child(muted(theme, row.kind.clone()))
                            .child(muted(theme, row.tokens.clone()))
                            .child(muted(theme, row.share.clone()))
                            .child(muted(theme, format!("{} turns", row.turns))),
                    );
                for detail in &row.detail {
                    item = item.child(muted(theme, detail.clone()));
                }
                ledger = ledger.child(item);
            }
        }
        root = root.child(ledger);
    }
    root = root.child(render_context_agents(state, theme, callbacks.clone()));
    root = root.child(render_context_threads(state, theme, callbacks.clone()));
    if state.git_available {
        root = root.child(action_button(
            &callbacks,
            "context-open-git",
            "Git",
            InspectorAction::OpenGit,
            state.disabled,
        ));
    }
    root
}

fn context_kind_color(kind: &str, theme: &EmmaTheme) -> gpui::Hsla {
    match kind {
        "messages" => theme.colors.blue,
        "system" => theme.colors.violet,
        "tools" => theme.colors.orange,
        "mcp" => theme.colors.teal,
        "skills" => theme.colors.lime,
        "memory" => theme.colors.yellow,
        "free" => theme.colors.text_3,
        _ => theme.colors.border_strong,
    }
}

fn render_context_agents(
    state: &ContextState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let live = state
        .agents
        .iter()
        .filter(|agent| agent.status == "running" || agent.status == "waiting")
        .collect::<Vec<_>>();
    let done = state
        .agents
        .iter()
        .filter(|agent| agent.status != "running" && agent.status != "waiting")
        .collect::<Vec<_>>();
    let mut root = v_flex()
        .id("context-subagents")
        .gap(theme.spacing.s2)
        .child(muted(
            theme,
            if live.is_empty() {
                "Subagents".to_owned()
            } else {
                format!("Subagents · {} working", live.len())
            },
        ));
    for agent in live
        .iter()
        .chain(done.iter().take(if state.done_agents_open {
            done.len()
        } else {
            done.len().min(3)
        }))
    {
        let callback = callbacks.clone();
        root = root.child(
            action_button(
                &callback,
                format!("context-agent-{}", agent.id),
                format!("{} · {}", agent.title, agent.status),
                InspectorAction::OpenAgent(agent.id.clone()),
                state.disabled,
            )
            .accessibility_label(format!(
                "{} — {}{}",
                agent.title,
                agent.activity,
                agent
                    .model
                    .as_ref()
                    .map(|model| format!(" · {model}"))
                    .unwrap_or_default()
            )),
        );
    }
    if state.agents.is_empty() {
        root = root.child(muted(
            theme,
            "Nothing delegated yet — a subagent gets a row here the moment it starts.",
        ));
    } else if !done.is_empty() {
        root = root.child(action_button(
            &callbacks,
            "context-agents-done",
            if state.done_agents_open {
                "Less finished agents"
            } else {
                "More finished agents"
            },
            InspectorAction::ToggleContextAgents,
            state.disabled,
        ));
    }
    root
}

fn render_context_threads(
    state: &ContextState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let working = state
        .threads
        .iter()
        .filter(|thread| thread.status == "running" || thread.status == "waiting")
        .count();
    let mut root = v_flex()
        .id("context-subthreads")
        .gap(theme.spacing.s1)
        .child(muted(
            theme,
            if state.threads.is_empty() {
                "Sub threads".to_owned()
            } else {
                format!(
                    "Sub threads · {} of {} working",
                    working,
                    state.threads.len()
                )
            },
        ));
    for thread in &state.threads {
        let callback = callbacks.clone();
        let open = action_button(
            &callback,
            format!("context-thread-{}", thread.id),
            format!("↳ {} · {}", thread.title, thread.age),
            InspectorAction::OpenSubthread(thread.id.clone()),
            state.disabled,
        )
        .accessibility_label(format!(
            "{} — {}",
            thread.title,
            thread
                .activity
                .clone()
                .unwrap_or_else(|| thread.age.clone())
        ));
        let mut row = h_flex().items_center().gap(theme.spacing.s1).child(open);
        if thread.status == "running" || thread.status == "waiting" {
            row = row.child(action_button(
                &callbacks,
                format!("context-thread-stop-{}", thread.id),
                "Stop",
                InspectorAction::StopSubthread(thread.id.clone()),
                state.disabled,
            ));
        }
        root = root.child(row);
    }
    if state.threads.is_empty() {
        root = root.child(muted(
            theme,
            "Nothing branched off yet — Emma opens one per threads spawn.",
        ));
    }
    root
}

fn render_context_settings(
    state: &ContextSettingsState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("context-bar-settings")
        .size_full()
        .min_w_0()
        .gap(theme.spacing.s4)
        .p(theme.spacing.s4)
        .bg(theme.colors.bg)
        .aria_label("Context bar settings");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(text_value(
                theme,
                format!("Pages · {} of 4", state.pages.len()),
            ))
            .child(action_button(
                &callbacks,
                "context-settings-new-page",
                "New page",
                InspectorAction::NewContextPage,
                state.busy || state.disabled,
            )),
    );
    if !state.pages.is_empty() {
        let mut tabs = h_flex()
            .id("context-settings-tabs")
            .w_full()
            .gap(theme.spacing.s1)
            .role(Role::TabList)
            .aria_label("Context bar pages");
        for page in &state.pages {
            let active = page == &state.active_page;
            let callback = callbacks.clone();
            let page_id = page.clone();
            tabs = tabs.child(
                Button::new(format!("context-page-{}", page))
                    .ghost()
                    .small()
                    .selected(active)
                    .role(Role::Tab)
                    .disabled(state.busy || state.disabled)
                    .accessibility_label(page.clone())
                    .label(page.clone())
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::SelectContextPage(page_id.clone()))
                    }),
            );
        }
        root = root.child(tabs);
    }
    root = root.child(
        v_flex()
            .gap(theme.spacing.s2)
            .child(muted(theme, "Name"))
            .child(input_value(
                inputs.context_page_name.as_ref(),
                "context-page-name",
                &state.page_name,
                "Context page name",
                state.busy || state.disabled,
                theme,
            )),
    );
    let mut workbench = h_flex().w_full().items_start().gap(theme.spacing.s4);
    let mut palette = v_flex()
        .id("context-settings-palette")
        .w(px(220.))
        .flex_none()
        .gap(theme.spacing.s2)
        .child(header(theme, "Components"));
    for widget in &state.widgets {
        palette = palette.child(muted(theme, format!("{} {}", widget.glyph, widget.label)));
    }
    for widget in &state.spare {
        let callback = callbacks.clone();
        palette = palette.child(
            action_button(
                &callback,
                format!("context-add-{}", widget.id),
                format!("{} {}", widget.glyph, widget.label),
                InspectorAction::AddContextWidget(widget.id.clone()),
                state.busy || state.disabled,
            )
            .tooltip(widget.id.clone()),
        );
    }
    let mut stage = v_flex()
        .id("context-settings-stage")
        .flex_1()
        .min_w_0()
        .gap(theme.spacing.s2)
        .child(header(theme, state.page_name.clone()));
    for (index, widget) in state.widgets.iter().enumerate() {
        let callback = callbacks.clone();
        let mut row = h_flex()
            .id(format!("context-widget-{}", widget.id))
            .w_full()
            .items_center()
            .gap(theme.spacing.s2)
            .p(theme.spacing.s3)
            .bg(theme.colors.surface)
            .border_1()
            .border_color(theme.colors.border)
            .child(text_value(
                theme,
                format!("{} {}", widget.glyph, widget.label),
            ))
            .child(muted(theme, widget.orientation.clone()));
        if state.editing {
            if index > 0 {
                let previous = &state.widgets[index - 1];
                row = row.child(action_button(
                    &callback,
                    format!("context-up-{}", widget.id),
                    "↑",
                    InspectorAction::ReorderContextWidget {
                        widget_id: widget.id.clone(),
                        before: previous.id.clone(),
                    },
                    state.busy || state.disabled,
                ));
            }
            if index + 1 < state.widgets.len() {
                let before = state
                    .widgets
                    .get(index + 2)
                    .map(|item| item.id.clone())
                    .unwrap_or_default();
                row = row.child(action_button(
                    &callback,
                    format!("context-down-{}", widget.id),
                    "↓",
                    InspectorAction::ReorderContextWidget {
                        widget_id: widget.id.clone(),
                        before,
                    },
                    state.busy || state.disabled,
                ));
            }
            row = row
                .child(action_button(
                    &callback,
                    format!("context-flip-{}", widget.id),
                    "Flip",
                    InspectorAction::ToggleContextWidget(widget.id.clone()),
                    state.busy || state.disabled,
                ))
                .child(action_button(
                    &callback,
                    format!("context-remove-{}", widget.id),
                    "×",
                    InspectorAction::RemoveContextWidget(widget.id.clone()),
                    state.busy || state.disabled,
                ));
        }
        stage = stage.child(row);
    }
    if state.widgets.is_empty() {
        stage = stage.child(muted(
            theme,
            "Nothing on this page — press ＋ to put a component back.",
        ));
    }
    workbench = workbench.child(palette).child(stage);
    root = root.child(workbench);
    root.child(
        h_flex()
            .justify_end()
            .gap(theme.spacing.s2)
            .child(action_button(
                &callbacks,
                "context-settings-edit",
                if state.editing { "Done" } else { "Edit" },
                InspectorAction::ToggleContextEditing,
                state.busy || state.disabled,
            )),
    )
}

fn build_graph(rows: &[Vec<String>], edges: &[PlanGraphEdge]) -> (Vec<PlanGraphNode>, f32, f32) {
    let layout = place_rows(
        rows,
        GraphBox {
            width: 190.,
            height: 76.,
            gap_x: 36.,
            gap_y: 64.,
            lane: 40.,
        },
    );
    let ids = edges
        .iter()
        .flat_map(|edge| [edge.from.as_str(), edge.to.as_str()])
        .collect::<std::collections::HashSet<_>>();
    let nodes = layout
        .placed
        .into_iter()
        .map(|placed| PlanGraphNode {
            id: placed.id.clone(),
            x: placed.x,
            y: placed.y,
            width: 190.,
            height: 76.,
            wave: rows
                .iter()
                .position(|row| row.iter().any(|id| id == &placed.id))
                .unwrap_or(0),
        })
        .filter(|node| ids.is_empty() || ids.contains(node.id.as_str()))
        .collect::<Vec<_>>();
    (nodes, layout.width, layout.height)
}

fn graph_edges(
    edges: &[PlanGraphEdge],
    nodes: &[PlanGraphNode],
    width: f32,
    theme: &EmmaTheme,
) -> AnyElement {
    let positions = nodes
        .iter()
        .map(|node| {
            (
                node.id.clone(),
                crate::workspace_pages::PlacedGraphNode {
                    id: node.id.clone(),
                    x: node.x,
                    y: node.y,
                },
            )
        })
        .collect::<std::collections::HashMap<_, _>>();
    let segments = edges
        .iter()
        .filter_map(|edge| {
            Some((
                positions.get(&edge.from)?.clone(),
                positions.get(&edge.to)?.clone(),
            ))
        })
        .collect::<Vec<_>>();
    let color = theme.colors.border_strong;
    canvas(
        move |_bounds, _window, _cx| segments,
        move |bounds, segments, window, _cx| {
            for (from, to) in segments {
                let path = edge_path(
                    &from,
                    &to,
                    GraphBox {
                        width: 190.,
                        height: 76.,
                        gap_x: 36.,
                        gap_y: 64.,
                        lane: 40.,
                    },
                    width,
                );
                let origin = bounds.origin;
                let at = |x: f32, y: f32| point(origin.x + px(x), origin.y + px(y));
                let mut builder = PathBuilder::stroke(px(1.));
                let x1 = from.x + 95.;
                let y1 = from.y + 76.;
                let x2 = to.x + 95.;
                let y2 = to.y - 2.;
                let straight = to.y - from.y == 140.;
                let lane = if to.y <= from.y { 20. } else { width - 20. };
                builder.move_to(at(x1, y1));
                if straight {
                    builder.cubic_bezier_to(at(x2, y2), at(x1, y1 + 32.), at(x2, to.y - 32.));
                } else {
                    builder.cubic_bezier_to(at(lane, y1 + 28.), at(x1, y1 + 24.), at(lane, y1));
                    builder.line_to(at(lane, y2 - 28.));
                    builder.cubic_bezier_to(at(x2, y2), at(lane, y2), at(x2, y2 - 28.));
                }
                if let Ok(stroke) = builder.build() {
                    window.paint_path(stroke, color);
                }
                let _ = path;
            }
        },
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

fn render_plan(
    state: &PlanRailState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-plan")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Plan");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let selected_plan = state
        .selected_plan
        .as_ref()
        .and_then(|id| state.plans.iter().find(|plan| &plan.id == id))
        .or_else(|| {
            state
                .plans
                .iter()
                .find(|plan| plan.steps.iter().any(|step| step.status == "running"))
        })
        .or_else(|| state.plans.first());
    let Some(plan) = selected_plan else {
        return root.child(muted(
            theme,
            "Nothing planned yet — Emma writes one per plan write.",
        ));
    };
    let done = plan
        .steps
        .iter()
        .filter(|step| step.status == "done")
        .count();
    root = root.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(text_value(
                theme,
                format!("Plan · {} of {} steps", done, plan.steps.len()),
            ))
            .child(action_button(
                &callbacks,
                format!("plan-open-{}", plan.id),
                "Expand",
                InspectorAction::OpenPlan(plan.id.clone()),
                state.disabled,
            )),
    );
    if state.plans.len() > 1 {
        let mut switch = h_flex()
            .id("plan-tabs")
            .w_full()
            .gap(theme.spacing.s1)
            .role(Role::TabList)
            .aria_label("Plans");
        for item in &state.plans {
            let active = item.id == plan.id;
            let callback = callbacks.clone();
            let plan_id = item.id.clone();
            switch = switch.child(
                Button::new(format!("plan-switch-{}", item.id))
                    .ghost()
                    .small()
                    .selected(active)
                    .role(Role::Tab)
                    .disabled(state.disabled)
                    .accessibility_label(format!("{} plan", item.title))
                    .label(item.title.clone())
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::PickPlan(plan_id.clone()))
                    }),
            );
        }
        root = root.child(switch);
    }
    root = root.child(
        v_flex()
            .gap(theme.spacing.s1)
            .child(text_value(theme, plan.title.clone()))
            .child(muted(theme, plan.goal.clone())),
    );
    let graph = if state.graph_nodes.is_empty() {
        let rows = plan_rows(&plan.steps);
        let edges = plan
            .steps
            .iter()
            .flat_map(|step| {
                step.needs.iter().map(|need| PlanGraphEdge {
                    from: need.clone(),
                    to: step.id.clone(),
                })
            })
            .collect::<Vec<_>>();
        let (nodes, width, height) = build_graph(&rows, &edges);
        render_plan_graph(
            plan,
            &nodes,
            &edges,
            width,
            height,
            state.selected_step.as_deref(),
            state.disabled,
            theme,
            callbacks.clone(),
        )
    } else {
        render_plan_graph(
            plan,
            &state.graph_nodes,
            &state.graph_edges,
            state.graph_width,
            state.graph_height,
            state.selected_step.as_deref(),
            state.disabled,
            theme,
            callbacks.clone(),
        )
    };
    root = root.child(graph);
    let mut key = h_flex().gap(theme.spacing.s3);
    for status in ["running", "ready", "waiting", "done", "failed"] {
        if plan.steps.iter().any(|step| plan_status(step) == status) {
            key = key.child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s1)
                    .child(
                        div()
                            .w(px(7.))
                            .h(px(7.))
                            .rounded(theme.radii.full)
                            .bg(plan_status_color(status, theme)),
                    )
                    .child(muted(theme, status)),
            );
        }
    }
    root = root.child(key);
    if let Some(step) = state
        .selected_step
        .as_ref()
        .and_then(|id| plan.steps.iter().find(|step| &step.id == id))
    {
        root = root.child(render_plan_step(step, theme));
    } else if let Some(step) = plan
        .steps
        .iter()
        .find(|step| step.status == "running")
        .or_else(|| plan.steps.iter().find(|step| step.status != "done"))
    {
        root = root.child(render_plan_step(step, theme));
    }
    root
}

fn plan_rows(steps: &[PlanStepSnapshot]) -> Vec<Vec<String>> {
    let mut waves = Vec::<Vec<String>>::new();
    let mut depth = std::collections::HashMap::<String, usize>::new();
    for step in steps {
        let wave = step
            .needs
            .iter()
            .filter_map(|need| depth.get(need).copied())
            .max()
            .map_or(0, |value| value + 1);
        depth.insert(step.id.clone(), wave);
        while waves.len() <= wave {
            waves.push(Vec::new());
        }
        waves[wave].push(step.id.clone());
    }
    waves
}

#[allow(clippy::too_many_arguments)]
fn render_plan_graph(
    plan: &PlanSnapshot,
    nodes: &[PlanGraphNode],
    edges: &[PlanGraphEdge],
    width: f32,
    height: f32,
    selected: Option<&str>,
    disabled: bool,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> AnyElement {
    let mut graph = div()
        .id(format!("plan-graph-{}", plan.id))
        .relative()
        .w(px(width.max(260.)))
        .h(px(height.max(76.)))
        .child(graph_edges(edges, nodes, width.max(260.), theme));
    for (index, node) in nodes.iter().enumerate() {
        let Some(step) = plan.steps.iter().find(|step| step.id == node.id) else {
            continue;
        };
        let callback = callbacks.clone();
        let plan_id = plan.id.clone();
        let step_id = step.id.clone();
        graph = graph.child(
            div()
                .id(format!("plan-node-wrap-{}", step.id))
                .absolute()
                .left(px(node.x))
                .top(px(node.y))
                .w(px(node.width))
                .h(px(node.height))
                .child(
                    Button::new(format!("plan-node-{}", step.id))
                        .ghost()
                        .small()
                        .w_full()
                        .h_full()
                        .selected(selected == Some(step.id.as_str()))
                        .disabled(disabled)
                        .accessibility_label(format!(
                            "{} — {}, step {}",
                            step.title,
                            plan_status(step),
                            index + 1
                        ))
                        .child(
                            v_flex()
                                .gap(theme.spacing.s1)
                                .items_start()
                                .child(muted(
                                    theme,
                                    format!("{} {}", plan_status_mark(step), plan_status(step)),
                                ))
                                .child(text_value(theme, step.title.clone()))
                                .when_some(step.activity.clone(), |row, activity| {
                                    row.child(muted(theme, activity))
                                }),
                        )
                        .on_click(move |_, _, _| {
                            callback.emit(InspectorAction::PickPlanStep {
                                plan_id: plan_id.clone(),
                                step_id: step_id.clone(),
                            })
                        }),
                ),
        );
    }
    div().overflow_x_scrollbar().child(graph).into_any_element()
}

fn plan_status(step: &PlanStepSnapshot) -> &'static str {
    match step.status.as_str() {
        "done" => "done",
        "running" => "running",
        "failed" => "failed",
        "todo" if step.needs.is_empty() => "ready",
        _ => "waiting",
    }
}

fn plan_status_mark(step: &PlanStepSnapshot) -> &'static str {
    match plan_status(step) {
        "done" => "✓",
        "running" => "●",
        "failed" => "!",
        "ready" => "◌",
        _ => "·",
    }
}

fn plan_status_color(status: &str, theme: &EmmaTheme) -> gpui::Hsla {
    match status {
        "done" => theme.colors.lime,
        "running" => theme.colors.teal,
        "failed" => theme.colors.danger,
        "ready" => theme.colors.accent,
        _ => theme.colors.text_3,
    }
}

fn render_plan_step(step: &PlanStepSnapshot, theme: &EmmaTheme) -> Stateful<Div> {
    let mut root = v_flex()
        .id(format!("plan-step-detail-{}", step.id))
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .bg(theme.colors.surface_2)
        .border_1()
        .border_color(theme.colors.border)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(text_value(theme, step.title.clone()))
                .child(muted(theme, plan_status(step))),
        )
        .child(muted(
            theme,
            if step.needs.is_empty() {
                "first wave"
            } else {
                "waits on listed steps"
            },
        ));
    if !step.needs.is_empty() {
        root = root.child(muted(theme, format!("needs: {}", step.needs.join(", "))));
    }
    if !step.brief.trim().is_empty() {
        root = root.child(text_value(theme, step.brief.clone()));
    }
    for task in &step.tasks {
        root = root.child(
            h_flex()
                .gap(theme.spacing.s2)
                .text_color(if task.done {
                    theme.colors.lime
                } else {
                    theme.colors.text_2
                })
                .child(if task.done { "▣" } else { "▢" })
                .child(task.text.clone()),
        );
    }
    if let Some(result) = &step.result {
        root = root.child(muted(theme, format!("Result: {result}")));
    }
    root
}

fn render_tasks(
    state: &TaskListState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-task-list")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Tasks");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let list = state
        .selected_list
        .as_ref()
        .and_then(|id| state.lists.iter().find(|list| &list.id == id))
        .or_else(|| state.lists.first());
    let Some(list) = list else {
        return root.child(muted(
            theme,
            "Nothing tracked yet — Emma writes one per task_list write.",
        ));
    };
    let (completed, total) = task_progress(&list.tasks);
    root = root.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(text_value(
                theme,
                format!("Tasks · {completed} of {total} tasks"),
            ))
            .child(action_button(
                &callbacks,
                format!("task-list-open-{}", list.id),
                "Expand",
                InspectorAction::OpenTaskList(list.id.clone()),
                state.disabled,
            )),
    );
    if state.lists.len() > 1 {
        let mut switch = h_flex()
            .id("task-list-tabs")
            .w_full()
            .gap(theme.spacing.s1)
            .role(Role::TabList)
            .aria_label("Task lists");
        for item in &state.lists {
            let active = item.id == list.id;
            let callback = callbacks.clone();
            let list_id = item.id.clone();
            switch = switch.child(
                Button::new(format!("task-list-switch-{}", item.id))
                    .ghost()
                    .small()
                    .selected(active)
                    .role(Role::Tab)
                    .disabled(state.disabled)
                    .accessibility_label(item.title.clone())
                    .label(item.title.clone())
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::PickTaskList(list_id.clone()))
                    }),
            );
        }
        root = root.child(switch);
    }
    root = root.child(
        v_flex()
            .gap(theme.spacing.s1)
            .child(text_value(theme, list.title.clone()))
            .child(muted(theme, list.goal.clone())),
    );
    let graph = if state.graph_nodes.is_empty() {
        let (nodes, edges, width, height) = task_graph(&list.tasks);
        render_task_graph(
            list,
            &nodes,
            &edges,
            width,
            height,
            state.selected_task.as_deref(),
            state.disabled,
            theme,
            callbacks.clone(),
        )
    } else {
        render_task_graph(
            list,
            &state.graph_nodes,
            &state.graph_edges,
            state.graph_width,
            state.graph_height,
            state.selected_task.as_deref(),
            state.disabled,
            theme,
            callbacks.clone(),
        )
    };
    root = root.child(graph);
    if let Some(task) = find_task(&list.tasks, state.selected_task.as_deref()) {
        root = root.child(render_task_detail(task, theme));
    } else if let Some(task) = first_active_task(&list.tasks) {
        root = root.child(render_task_detail(task, theme));
    }
    root
}

fn task_progress(tasks: &[TaskSnapshot]) -> (usize, usize) {
    let mut completed = 0;
    let mut total = 0;
    for task in tasks {
        total += 1;
        if task.status == "completed" {
            completed += 1;
        }
        let (child_completed, child_total) = task_progress(&task.subtasks);
        completed += child_completed;
        total += child_total;
    }
    (completed, total)
}

fn task_graph(tasks: &[TaskSnapshot]) -> (Vec<PlanGraphNode>, Vec<PlanGraphEdge>, f32, f32) {
    let mut rows = Vec::<Vec<String>>::new();
    let mut edges = Vec::new();
    fn visit(
        tasks: &[TaskSnapshot],
        depth: usize,
        rows: &mut Vec<Vec<String>>,
        edges: &mut Vec<PlanGraphEdge>,
        parent: Option<&str>,
    ) {
        while rows.len() <= depth {
            rows.push(Vec::new());
        }
        for task in tasks {
            rows[depth].push(task.id.clone());
            if let Some(parent) = parent {
                edges.push(PlanGraphEdge {
                    from: parent.to_owned(),
                    to: task.id.clone(),
                });
            }
            visit(
                &task.subtasks,
                depth + 1,
                rows,
                edges,
                Some(task.id.as_str()),
            );
        }
    }
    visit(tasks, 0, &mut rows, &mut edges, None);
    let (nodes, width, height) = build_graph(&rows, &edges);
    (nodes, edges, width, height)
}

#[allow(clippy::too_many_arguments)]
fn render_task_graph(
    list: &TaskListSnapshot,
    nodes: &[PlanGraphNode],
    edges: &[PlanGraphEdge],
    width: f32,
    height: f32,
    selected: Option<&str>,
    disabled: bool,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> AnyElement {
    let mut graph = div()
        .id(format!("task-graph-{}", list.id))
        .relative()
        .w(px(width.max(260.)))
        .h(px(height.max(76.)))
        .child(graph_edges(edges, nodes, width.max(260.), theme));
    let flat = flatten_tasks(&list.tasks);
    for (index, node) in nodes.iter().enumerate() {
        let Some(task) = flat.iter().find(|task| task.id == node.id) else {
            continue;
        };
        let callback = callbacks.clone();
        let task_id = task.id.clone();
        graph = graph.child(
            div()
                .id(format!("task-node-wrap-{}", task.id))
                .absolute()
                .left(px(node.x))
                .top(px(node.y))
                .w(px(node.width))
                .h(px(node.height))
                .child(
                    Button::new(format!("task-node-{}", task.id))
                        .ghost()
                        .small()
                        .w_full()
                        .h_full()
                        .selected(selected == Some(task.id.as_str()))
                        .disabled(disabled)
                        .accessibility_label(format!(
                            "{} — {}, task {}",
                            task.title,
                            task.status,
                            index + 1
                        ))
                        .child(
                            v_flex()
                                .gap(theme.spacing.s1)
                                .items_start()
                                .child(muted(theme, task.status.clone()))
                                .child(text_value(theme, task.title.clone()))
                                .when(!task.subtasks.is_empty(), |row| {
                                    row.child(muted(
                                        theme,
                                        format!("{} subtasks", task.subtasks.len()),
                                    ))
                                }),
                        )
                        .on_click(move |_, _, _| {
                            callback.emit(InspectorAction::PickTask(task_id.clone()))
                        }),
                ),
        );
    }
    div().overflow_x_scrollbar().child(graph).into_any_element()
}

fn flatten_tasks(tasks: &[TaskSnapshot]) -> Vec<TaskSnapshot> {
    let mut flat = Vec::new();
    fn visit(tasks: &[TaskSnapshot], flat: &mut Vec<TaskSnapshot>) {
        for task in tasks {
            flat.push(task.clone());
            visit(&task.subtasks, flat);
        }
    }
    visit(tasks, &mut flat);
    flat
}

fn find_task<'a>(tasks: &'a [TaskSnapshot], id: Option<&str>) -> Option<&'a TaskSnapshot> {
    let id = id?;
    tasks.iter().find_map(|task| {
        if task.id == id {
            Some(task)
        } else {
            find_task(&task.subtasks, Some(id))
        }
    })
}

fn first_active_task(tasks: &[TaskSnapshot]) -> Option<&TaskSnapshot> {
    tasks
        .iter()
        .find(|task| task.status == "in_progress")
        .or_else(|| tasks.iter().find(|task| task.status == "pending"))
        .or_else(|| tasks.first())
}

fn render_task_detail(task: &TaskSnapshot, theme: &EmmaTheme) -> Stateful<Div> {
    let mut root = v_flex()
        .id(format!("task-detail-{}", task.id))
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .bg(theme.colors.surface_2)
        .border_1()
        .border_color(theme.colors.border)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(text_value(theme, task.title.clone()))
                .child(muted(theme, task.status.clone())),
        );
    if let Some(parent) = &task.parent_id {
        root = root.child(muted(theme, format!("subtask of {parent}")));
    } else {
        root = root.child(muted(theme, "top level"));
    }
    if task.subtasks.is_empty() {
        root = root.child(muted(theme, "No subtasks — this node is one action."));
    } else {
        for subtask in &task.subtasks {
            root = root.child(
                h_flex()
                    .gap(theme.spacing.s2)
                    .child(if subtask.status == "completed" {
                        "▣"
                    } else {
                        "▢"
                    })
                    .child(subtask.title.clone()),
            );
        }
    }
    root
}

#[derive(Clone)]
struct TimelineRowView {
    span: TimelineSpan,
    depth: usize,
    offset: f32,
    width: f32,
    duration: u64,
    children: usize,
}

fn render_timeline(
    state: &TimelineState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-timeline")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Agent timeline");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let spans = timeline_spans(state);
    if spans.len() < 2 {
        return root.child(muted(
            theme,
            "No timed replies yet — the waterfall appears after a model or tool span lands.",
        ));
    }
    let rows = timeline_rows(&spans, state.axis, state.now, &state.collapsed);
    let total = rows.first().map(|row| row.duration).unwrap_or(0);
    let running = spans.iter().any(|span| span.ended_at.is_none());
    let weighed = spans.iter().skip(1).any(|span| span.tokens.is_some());
    let mut title = h_flex()
        .items_center()
        .justify_between()
        .child(
            v_flex()
                .gap(theme.spacing.s1)
                .child(text_value(theme, "Timeline"))
                .child(muted(
                    theme,
                    format!(
                        "{}{}",
                        format_duration(total, state.axis),
                        if running { " · running" } else { "" }
                    ),
                )),
        )
        .child(action_button(
            &callbacks,
            "timeline-expand",
            "Expand",
            InspectorAction::OpenTimeline,
            state.disabled,
        ));
    if weighed {
        let time_callback = callbacks.clone();
        let context_callback = callbacks.clone();
        title = title.child(
            h_flex()
                .gap(theme.spacing.s1)
                .child(
                    action_button(
                        &time_callback,
                        "timeline-time",
                        "Time",
                        InspectorAction::ToggleTimelineAxis,
                        state.disabled || state.axis == TimelineAxis::Time,
                    )
                    .selected(state.axis == TimelineAxis::Time),
                )
                .child(
                    action_button(
                        &context_callback,
                        "timeline-context",
                        "Context",
                        InspectorAction::ToggleTimelineAxis,
                        state.disabled || state.axis == TimelineAxis::Context,
                    )
                    .selected(state.axis == TimelineAxis::Context),
                ),
        );
    }
    root = root.child(title);
    let mut list = v_flex()
        .id("timeline-rows")
        .gap(theme.spacing.s1)
        .max_h(if state.expanded { px(620.) } else { px(260.) })
        .role(Role::List)
        .overflow_y_scrollbar();
    for row in rows {
        let selected = state.selected.as_deref() == Some(row.span.id.as_str());
        let collapsed = state.collapsed.iter().any(|id| id == &row.span.id);
        let callback = callbacks.clone();
        let span_id = row.span.id.clone();
        let mut head = h_flex()
            .id(format!("timeline-head-{}", row.span.id))
            .items_center()
            .gap(theme.spacing.s2)
            .pl(px(row.depth as f32 * 12.))
            .child(if row.children > 0 {
                if collapsed { "▸" } else { "▾" }
            } else {
                "·"
            })
            .child(
                Button::new(format!("timeline-name-{}", row.span.id))
                    .ghost()
                    .small()
                    .flex_1()
                    .justify_start()
                    .selected(selected)
                    .accessibility_label(format!(
                        "{} — {} · {}",
                        row.span.name,
                        row.span.kind,
                        format_duration(row.duration, state.axis)
                    ))
                    .child(row.span.name.clone())
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::PickTimelineSpan(span_id.clone()))
                    }),
            )
            .child(muted(theme, format_duration(row.duration, state.axis)));
        if row.children > 0 {
            let toggle = callbacks.clone();
            let span_id = row.span.id.clone();
            head = head.on_click(move |_, _, _| {
                toggle.emit(InspectorAction::ToggleTimelineRow(span_id.clone()))
            });
        }
        let track = div()
            .id(format!("timeline-track-{}", row.span.id))
            .relative()
            .h(px(7.))
            .flex_1()
            .bg(theme.colors.surface_3)
            .child(
                div()
                    .absolute()
                    .left(relative(row.offset / 100.))
                    .h(px(7.))
                    .w(relative((row.width / 100.).max(0.015)))
                    .bg(timeline_color(&row.span, theme)),
            );
        list = list.child(
            v_flex()
                .id(format!("timeline-row-{}", row.span.id))
                .gap(theme.spacing.s1)
                .role(Role::ListItem)
                .child(head)
                .child(track),
        );
        if state.selected.as_deref() == Some(row.span.id.as_str()) {
            list = list.child(render_span_detail(&row.span, state.now, theme));
        }
    }
    root = root.child(list);
    if state.expanded {
        root = root.child(render_timeline_summary(&spans, state.now, theme));
    }
    root
}

fn timeline_spans(state: &TimelineState) -> Vec<TimelineSpan> {
    let mut result = Vec::new();
    let mut cursor = 0u64;
    let mut total_tokens = 0usize;
    for (index, turn) in state.turns.iter().enumerate() {
        if turn.spans.is_empty() {
            continue;
        }
        let from = turn
            .spans
            .iter()
            .map(|span| span.started_at)
            .min()
            .unwrap_or(0);
        let to = turn
            .spans
            .iter()
            .map(|span| {
                span.ended_at.unwrap_or(if turn.live {
                    state.now
                } else {
                    span.started_at
                })
            })
            .max()
            .unwrap_or(from);
        let shift = cursor.saturating_sub(from);
        for span in &turn.spans {
            let id = format!("{}/{}", turn.id, span.id);
            let start = span.started_at.saturating_add(shift);
            let end = span
                .ended_at
                .unwrap_or(if turn.live {
                    state.now
                } else {
                    span.started_at
                })
                .saturating_add(shift);
            total_tokens = total_tokens.saturating_add(span.tokens.unwrap_or(0));
            result.push(TimelineSpan {
                id,
                parent_id: span
                    .parent_id
                    .as_ref()
                    .map(|parent| format!("{}/{}", turn.id, parent)),
                name: if span.parent_id.is_none() {
                    format!("Turn {} · {}", index + 1, turn.label)
                } else {
                    span.name.clone()
                },
                kind: span.kind.clone(),
                started_at: start,
                ended_at: if span.ended_at.is_some() || !turn.live {
                    Some(end)
                } else {
                    None
                },
                status: span.status.clone(),
                input: span.input.clone(),
                output: span.output.clone(),
                tokens: span.tokens,
            });
        }
        cursor = cursor.max(to.saturating_add(shift));
    }
    result.insert(
        0,
        TimelineSpan {
            id: "overall".to_owned(),
            parent_id: None,
            name: "Overall".to_owned(),
            kind: "agent".to_owned(),
            started_at: 0,
            ended_at: Some(cursor),
            status: if result.iter().any(|span| span.ended_at.is_none()) {
                "running".to_owned()
            } else {
                "ok".to_owned()
            },
            input: None,
            output: None,
            tokens: Some(state.carried_tokens.saturating_sub(total_tokens)),
        },
    );
    result
}

fn timeline_rows(
    spans: &[TimelineSpan],
    axis: TimelineAxis,
    now: u64,
    collapsed: &[String],
) -> Vec<TimelineRowView> {
    if spans.is_empty() {
        return Vec::new();
    }
    let mut children = std::collections::HashMap::<String, Vec<&TimelineSpan>>::new();
    let mut roots = Vec::<&TimelineSpan>::new();
    let ids = spans
        .iter()
        .map(|span| span.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    for span in spans {
        if let Some(parent) = span.parent_id.as_deref().filter(|id| ids.contains(id)) {
            children.entry(parent.to_owned()).or_default().push(span);
        } else {
            roots.push(span);
        }
    }
    for values in children.values_mut() {
        values.sort_by_key(|span| span.started_at);
    }
    roots.sort_by_key(|span| span.started_at);
    let close = |span: &TimelineSpan| span.ended_at.unwrap_or(now);
    let start = spans.iter().map(|span| span.started_at).min().unwrap_or(0);
    let total = match axis {
        TimelineAxis::Time => spans
            .iter()
            .map(close)
            .max()
            .unwrap_or(start)
            .saturating_sub(start)
            .max(1),
        TimelineAxis::Context => spans
            .iter()
            .map(|span| span.tokens.unwrap_or(0) as u64)
            .sum::<u64>()
            .max(1),
    };
    let mut result = Vec::new();
    let mut cursor = 0u64;
    #[allow(clippy::too_many_arguments)]
    fn visit<'a>(
        span: &'a TimelineSpan,
        depth: usize,
        children: &std::collections::HashMap<String, Vec<&'a TimelineSpan>>,
        axis: TimelineAxis,
        now: u64,
        start: u64,
        total: u64,
        collapsed: &[String],
        cursor: &mut u64,
        result: &mut Vec<TimelineRowView>,
    ) {
        let duration = match axis {
            TimelineAxis::Time => span.ended_at.unwrap_or(now).saturating_sub(span.started_at),
            TimelineAxis::Context => span.tokens.unwrap_or(0) as u64,
        };
        let offset = match axis {
            TimelineAxis::Time => span.started_at.saturating_sub(start),
            TimelineAxis::Context => *cursor,
        };
        let width = duration.max(1);
        if matches!(axis, TimelineAxis::Context) {
            *cursor = cursor.saturating_add(width);
        }
        let kids = children.get(&span.id).map_or(0, Vec::len);
        result.push(TimelineRowView {
            span: span.clone(),
            depth,
            offset: offset as f32 / total as f32 * 100.,
            width: width as f32 / total as f32 * 100.,
            duration,
            children: kids,
        });
        if !collapsed.iter().any(|id| id == &span.id)
            && let Some(kids) = children.get(&span.id)
        {
            for child in kids {
                visit(
                    child,
                    depth + 1,
                    children,
                    axis,
                    now,
                    start,
                    total,
                    collapsed,
                    cursor,
                    result,
                );
            }
        }
    }
    for root in roots {
        visit(
            root,
            0,
            &children,
            axis,
            now,
            start,
            total,
            collapsed,
            &mut cursor,
            &mut result,
        );
    }
    result
}

fn format_duration(value: u64, axis: TimelineAxis) -> String {
    if axis == TimelineAxis::Context {
        return format!("{value} tok");
    }
    if value < 1_000 {
        format!("{value}ms")
    } else if value < 60_000 {
        format!("{:.2}s", value as f32 / 1_000.)
    } else {
        format!("{}m {:02}s", value / 60_000, (value % 60_000) / 1_000)
    }
}

fn timeline_color(span: &TimelineSpan, theme: &EmmaTheme) -> gpui::Hsla {
    if span.status == "failed" {
        return theme.colors.danger;
    }
    match span.kind.as_str() {
        "agent" => theme.colors.accent,
        "model" => theme.colors.violet,
        _ => theme.colors.teal,
    }
}

fn render_span_detail(span: &TimelineSpan, now: u64, theme: &EmmaTheme) -> Stateful<Div> {
    let duration = span.ended_at.unwrap_or(now).saturating_sub(span.started_at);
    let mut detail = v_flex()
        .id(format!("timeline-detail-{}", span.id))
        .gap(theme.spacing.s1)
        .ml(px(20.))
        .p(theme.spacing.s2)
        .bg(theme.colors.surface_2)
        .child(text_value(theme, span.name.clone()))
        .child(muted(
            theme,
            format!(
                "{} · {} · {}",
                span.kind,
                span.status,
                format_duration(duration, TimelineAxis::Time)
            ),
        ));
    if let Some(input) = &span.input {
        detail = detail.child(muted(theme, format!("Input: {input}")));
    }
    detail.child(text_value(
        theme,
        span.output.clone().unwrap_or_else(|| {
            if span.ended_at.is_none() {
                "Still running.".to_owned()
            } else {
                "This span reported no output.".to_owned()
            }
        }),
    ))
}

fn render_timeline_summary(spans: &[TimelineSpan], now: u64, theme: &EmmaTheme) -> Div {
    let model = spans.iter().filter(|span| span.kind == "model").count();
    let tools = spans
        .iter()
        .filter(|span| span.kind != "agent" && span.kind != "model" && span.kind != "verifier")
        .count();
    let failed = spans.iter().filter(|span| span.status == "failed").count();
    let from = spans.iter().map(|span| span.started_at).min().unwrap_or(0);
    let to = spans
        .iter()
        .map(|span| span.ended_at.unwrap_or(now))
        .max()
        .unwrap_or(from);
    h_flex()
        .w_full()
        .flex_wrap()
        .gap(theme.spacing.s3)
        .child(muted(
            theme,
            format!(
                "Turns · {}",
                spans
                    .iter()
                    .filter(|span| span.name.starts_with("Turn "))
                    .count()
            ),
        ))
        .child(muted(
            theme,
            format!(
                "Lifetime · {}",
                format_duration(to.saturating_sub(from), TimelineAxis::Time)
            ),
        ))
        .child(muted(theme, format!("Model requests · {model}")))
        .child(muted(theme, format!("Tool calls · {tools}")))
        .child(muted(theme, format!("Failed spans · {failed}")))
}

fn render_machine(state: &MachineSurfaceState, theme: &EmmaTheme) -> Stateful<Div> {
    match state.view {
        MachineView::Stats => render_machine_stats(state, theme),
        MachineView::Graph => render_machine_graph(state, theme),
        MachineView::Meters => render_machine_meters(state, theme),
    }
}

fn render_machine_stats(state: &MachineSurfaceState, theme: &EmmaTheme) -> Stateful<Div> {
    let latest = state.samples.last();
    let mut root = v_flex()
        .id("inspector-machine")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Machine");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(text_value(theme, "Machine · now"))
            .child(muted(theme, state.orientation.clone())),
    );
    let Some(latest) = latest else {
        return root.child(muted(theme, "Reading this computer…"));
    };
    let network = latest.rx_bytes.saturating_add(latest.tx_bytes);
    let values = [
        (
            "CPU",
            format_percent(latest.cpu),
            latest.cpu,
            theme.colors.teal,
        ),
        (
            "Memory",
            format_percent(latest.memory),
            latest.memory,
            theme.colors.violet,
        ),
        (
            "GPU",
            latest.gpu.map_or_else(|| "—".to_owned(), format_percent),
            latest.gpu.unwrap_or(0.),
            theme.colors.lime,
        ),
        (
            "Network",
            format!("{}/s", size_label(network)),
            (network as f32 / (64. * 1024.)).min(1.),
            theme.colors.blue,
        ),
    ];
    let mut stats = v_flex().gap(theme.spacing.s2);
    for (index, (label, value, ratio, color)) in values.iter().enumerate() {
        let mut meter = h_flex()
            .id(format!("machine-meter-{index}"))
            .items_center()
            .gap(theme.spacing.s2)
            .child(div().w(px(58.)).text_color(*color).child(*label))
            .child(
                div()
                    .relative()
                    .h(px(8.))
                    .flex_1()
                    .bg(theme.colors.surface_3)
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .h(px(8.))
                            .w(relative(ratio.clamp(0., 1.)))
                            .bg(*color),
                    ),
            )
            .child(text_value(theme, value.clone()));
        if *label == "GPU" && latest.gpu.is_none() {
            meter = meter.aria_label("This computer reports no GPU utilisation");
        }
        stats = stats.child(meter);
    }
    root = root.child(stats).child(muted(
        theme,
        format!(
            "{} of {} · {} ↓ {} ↑",
            size_label(latest.memory_used_bytes),
            size_label(latest.memory_total_bytes),
            size_label(latest.rx_bytes),
            size_label(latest.tx_bytes)
        ),
    ));
    if state.samples.len() > 1 {
        let mut history = v_flex()
            .id("machine-history")
            .gap(theme.spacing.s2)
            .child(muted(
                theme,
                format!("Machine · last {}s", state.samples.len()),
            ));
        for (label, _, _, color) in values.iter() {
            let mut line = h_flex()
                .items_center()
                .gap(theme.spacing.s2)
                .child(div().w(px(58.)).text_color(*color).child(*label));
            for sample in state.samples.iter().rev().take(24).rev() {
                let ratio = match *label {
                    "CPU" => sample.cpu,
                    "Memory" => sample.memory,
                    "GPU" => sample.gpu.unwrap_or(0.),
                    _ => ((sample.rx_bytes + sample.tx_bytes) as f32 / (64. * 1024.)).min(1.),
                };
                line = line.child(
                    div()
                        .w(px(4.))
                        .h(px((ratio.clamp(0., 1.) * 24.).max(1.)))
                        .bg(*color),
                );
            }
            history = history.child(line);
        }
        root = root.child(history);
    }
    root
}

fn render_machine_graph(state: &MachineSurfaceState, theme: &EmmaTheme) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-machine-graph")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Machine history");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(muted(
        theme,
        format!("Machine · last {}s", state.samples.len().max(1)),
    ));
    let Some(latest) = state.samples.last() else {
        return root.child(muted(theme, "Reading this computer…"));
    };
    let series = [
        ("CPU", theme.colors.teal, latest.cpu),
        ("Memory", theme.colors.violet, latest.memory),
        ("GPU", theme.colors.lime, latest.gpu.unwrap_or_default()),
        (
            "Network",
            theme.colors.blue,
            ((latest.rx_bytes.saturating_add(latest.tx_bytes)) as f32 / (64. * 1024.)).min(1.),
        ),
    ];
    let mut graph = v_flex().gap(theme.spacing.s2);
    for (index, (label, color, ratio)) in series.into_iter().enumerate() {
        let mut row = h_flex()
            .id(format!("machine-graph-row-{index}"))
            .items_center()
            .gap(theme.spacing.s2)
            .child(div().w(px(58.)).text_color(color).child(label));
        let peak = if label == "Network" { 64. * 1024. } else { 1. };
        let mut samples = h_flex().items_end().gap(px(1.));
        for sample in state.samples.iter().rev().take(48).rev() {
            let value = match label {
                "CPU" => sample.cpu,
                "Memory" => sample.memory,
                "GPU" => sample.gpu.unwrap_or_default(),
                _ => (sample.rx_bytes.saturating_add(sample.tx_bytes)) as f32,
            };
            let value = (value / peak).clamp(0., 1.);
            samples = samples.child(div().w(px(3.)).h(px((value * 28.).max(1.))).bg(color));
        }
        row = row.child(samples.flex_1()).child(text_value(
            theme,
            if label == "GPU" && latest.gpu.is_none() {
                "—".to_owned()
            } else if label == "Network" {
                format!(
                    "{}/s",
                    size_label(latest.rx_bytes.saturating_add(latest.tx_bytes))
                )
            } else {
                format_percent(ratio)
            },
        ));
        graph = graph.child(row);
    }
    root.child(graph)
}

fn render_machine_meters(state: &MachineSurfaceState, theme: &EmmaTheme) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-machine-meters")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Machine meters");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(text_value(theme, "Machine"));
    let Some(latest) = state.samples.last() else {
        return root.child(muted(theme, "Reading this computer…"));
    };
    let moved = latest.rx_bytes.saturating_add(latest.tx_bytes);
    let series = [
        ("CPU", theme.colors.teal, latest.cpu, false),
        ("Memory", theme.colors.violet, latest.memory, false),
        (
            "GPU",
            theme.colors.lime,
            latest.gpu.unwrap_or_default(),
            latest.gpu.is_none(),
        ),
        ("Network", theme.colors.blue, 1., false),
    ];
    let mut rows = v_flex().gap(theme.spacing.s2);
    for (index, (label, color, ratio, unavailable)) in series.into_iter().enumerate() {
        let filled = if label == "Network" {
            16
        } else {
            (ratio.clamp(0., 1.) * 16.).round() as usize
        };
        let down = if label == "Network" && moved > 0 {
            ((latest.rx_bytes as f32 / moved as f32) * 16.).round() as usize
        } else {
            0
        };
        let mut cells = h_flex().gap(px(2.));
        for cell in 0..16 {
            let on = cell < filled;
            let half = label == "Network" && cell >= down;
            cells = cells.child(
                div()
                    .id(format!("machine-meter-cell-{index}-{cell}"))
                    .w(px(7.))
                    .h(px(10.))
                    .bg(if on {
                        color
                    } else if half {
                        theme.colors.border_strong
                    } else {
                        theme.colors.surface_3
                    }),
            );
        }
        let value = if unavailable {
            "—".to_owned()
        } else if label == "Network" {
            format!("{}/s", size_label(moved))
        } else {
            format_percent(ratio)
        };
        let mut row = h_flex()
            .id(format!("machine-meter-row-{index}"))
            .items_center()
            .gap(theme.spacing.s2)
            .child(div().w(px(58.)).text_color(color).child(label))
            .child(cells)
            .child(text_value(theme, value));
        if unavailable {
            row = row.aria_label("This computer reports no GPU utilisation");
        } else {
            row = row.aria_label(format!("{label} {ratio:.0}%"));
        }
        rows = rows.child(row);
    }
    root.child(rows)
}

fn format_percent(value: f32) -> String {
    format!("{}%", (value.clamp(0., 1.) * 100.).round() as usize)
}

fn size_label(value: u64) -> String {
    if value >= 1024 * 1024 * 1024 {
        format!("{:.1}G", value as f32 / (1024. * 1024. * 1024.))
    } else if value >= 1024 * 1024 {
        let precision = if value >= 10 * 1024 * 1024 { 0 } else { 1 };
        format!(
            "{value_mb:.precision$}M",
            value_mb = value as f32 / (1024. * 1024.)
        )
    } else if value >= 1024 {
        format!("{}K", value / 1024)
    } else {
        format!("{value}B")
    }
}

fn render_git_panel(
    state: &GitPanelState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-git-panel")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s3)
        .role(Role::Region)
        .aria_label("Git changes");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let Some(snapshot) = &state.snapshot else {
        return root.child(render_git_setup(state, theme, callbacks));
    };
    let selected = snapshot
        .files
        .iter()
        .filter(|file| !state.excluded.iter().any(|path| path == &file.path))
        .count();
    let total_added = snapshot.files.iter().map(|file| file.added).sum::<usize>();
    let total_removed = snapshot
        .files
        .iter()
        .map(|file| file.removed)
        .sum::<usize>();
    root = root.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(
                v_flex()
                    .gap(theme.spacing.s1)
                    .child(text_value(theme, format!("Branch · {}", snapshot.branch)))
                    .child(muted(
                        theme,
                        if snapshot.files.is_empty() {
                            "Working tree clean".to_owned()
                        } else {
                            format!("{} files · {} selected", snapshot.files.len(), selected)
                        },
                    )),
            )
            .child(change_count(theme, total_added, total_removed)),
    );
    if snapshot.ahead > 0 || snapshot.behind > 0 {
        root = root.child(muted(
            theme,
            format!(
                "↑{} ↓{} {}",
                snapshot.ahead, snapshot.behind, snapshot.upstream
            ),
        ));
    }
    if snapshot.worktree {
        root = root.child(muted(theme, "worktree"));
    }
    let files = snapshot
        .diff_files
        .iter()
        .filter(|file| matches_git_filter(&state.filter, &file.path))
        .collect::<Vec<_>>();
    let mut body = v_flex()
        .id("inspector-git-files")
        .gap(theme.spacing.s2)
        .max_h(if state.full { px(620.) } else { px(360.) })
        .overflow_y_scrollbar();
    if files.is_empty() {
        body = body.child(muted(
            theme,
            if state.filter.is_empty() {
                "Working tree clean.".to_owned()
            } else {
                "No file matches that filter.".to_owned()
            },
        ));
    }
    for file in files {
        let callback = callbacks.clone();
        let mut row = v_flex()
            .id(format!("git-file-{}", file.path))
            .gap(theme.spacing.s1)
            .p(theme.spacing.s2)
            .border_1()
            .border_color(theme.colors.border)
            .child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(file_mark(theme, &file.path))
                    .child(
                        div()
                            .flex_1()
                            .min_w_0()
                            .text_color(theme.colors.text)
                            .child(file.path.clone()),
                    )
                    .child(change_count(theme, file.added, file.removed))
                    .child(muted(theme, git_file_state(file))),
            );
        if !file.lines.is_empty() {
            let mut diff = v_flex()
                .id(format!("git-diff-{}", file.path))
                .max_h(px(250.))
                .overflow_y_scrollbar()
                .p(theme.spacing.s2)
                .bg(theme.colors.surface_2)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_2xs);
            for (index, line) in file.lines.iter().enumerate() {
                let color = match line.kind {
                    '+' => theme.colors.lime,
                    '-' => theme.colors.rose,
                    '@' => theme.colors.violet,
                    _ => theme.colors.text_2,
                };
                diff = diff.child(
                    div()
                        .id(format!("git-line-{}-{}", file.path, index))
                        .text_color(color)
                        .child(format!("{}{}", line.kind, line.text)),
                );
            }
            row = row.child(diff);
        }
        row = row.child(h_flex().justify_end().child(action_button(
            &callback,
            format!("git-open-file-{}", file.path),
            "Open",
            InspectorAction::OpenGitFile(file.path.clone()),
            state.disabled,
        )));
        body = body.child(row);
    }
    let filter = input_value(
        inputs.git_filter.as_ref(),
        "git-filter",
        &state.filter,
        "Filter changed files",
        state.busy || state.disabled,
        theme,
    );
    root = root.child(filter).child(body);
    if snapshot.truncated {
        root = root.child(muted(
            theme,
            "Diff cut at its size limit — later files are not listed.",
        ));
    }
    if let Some(folder_id) = &state.folder_id {
        root = root.child(action_button(
            &callbacks,
            "git-open-page",
            "Open full diff",
            InspectorAction::OpenGitPath(folder_id.clone()),
            state.disabled,
        ));
    }
    root
}

fn render_git_setup(
    state: &GitPanelState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let body = match state.ready {
        GitReadyState::NoGit => v_flex()
            .gap(theme.spacing.s2)
            .child(text_value(theme, "Git is not installed"))
            .child(muted(theme, "xcode-select --install")),
        GitReadyState::NoRepo => v_flex()
            .gap(theme.spacing.s2)
            .child(text_value(theme, "No repository here yet"))
            .child(action_button(
                &callbacks,
                "git-init",
                "git init",
                InspectorAction::InitializeGit(state.folder_id.clone().unwrap_or_default()),
                state.busy || state.disabled,
            )),
        GitReadyState::Ready => v_flex()
            .gap(theme.spacing.s2)
            .child(text_value(theme, "Reading repository…")),
    };
    panel(theme, "git-setup")
        .child(div().text_size(theme.typography.fs_lg).child("⑂"))
        .child(body)
}

fn matches_git_filter(query: &str, path: &str) -> bool {
    let terms = query
        .to_ascii_lowercase()
        .split_whitespace()
        .map(str::to_owned)
        .collect::<Vec<_>>();
    if terms.is_empty() {
        return true;
    }
    let target = path.to_ascii_lowercase();
    let name = target.rsplit('/').next().unwrap_or(&target);
    terms.iter().all(|term| {
        let extension = if let Some(extension) = term.strip_prefix("*.") {
            Some(format!(".{extension}"))
        } else {
            term.starts_with('.').then(|| term.clone())
        };
        if let Some(extension) = extension {
            target.ends_with(&extension)
        } else if target.contains(term) {
            true
        } else {
            let mut offset = 0;
            term.chars().all(|character| {
                let Some(found) = name[offset..].find(character) else {
                    return false;
                };
                offset += found + character.len_utf8();
                true
            })
        }
    })
}

fn git_file_state(file: &GitFileSnapshot) -> &'static str {
    if file.index == "?" || file.work == "?" {
        "untracked"
    } else if file.index == "U"
        || file.work == "U"
        || (file.index == "A" && file.work == "A")
        || (file.index == "D" && file.work == "D")
    {
        "conflict"
    } else if file.index == "R" {
        "renamed"
    } else if file.index == "A" {
        "new"
    } else if file.index == "D" || file.work == "D" {
        "deleted"
    } else {
        "modified"
    }
}

fn file_mark(theme: &EmmaTheme, path: &str) -> Div {
    let extension = path
        .rsplit('/')
        .next()
        .and_then(|name| name.rsplit('.').next())
        .filter(|extension| *extension != path);
    div()
        .w(px(24.))
        .text_center()
        .font_family(theme.typography.font_mono.clone())
        .text_color(theme.colors.text_3)
        .child(extension.unwrap_or("·").chars().take(4).collect::<String>())
}

fn render_git_page(
    state: &GitPageState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-git-page")
        .size_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s4)
        .bg(theme.colors.bg)
        .role(Role::Region)
        .aria_label("Git");
    if let Some(status) = status_panel(&state.panel.status, theme) {
        root = root.child(status);
    }
    let Some(snapshot) = &state.panel.snapshot else {
        return root.child(render_git_setup(&state.panel, theme, callbacks));
    };
    let branch_callback = callbacks.clone();
    let mut top = h_flex().items_center().gap(theme.spacing.s2).child(
        action_button(
            &branch_callback,
            "git-branch-trigger",
            format!("⑂ {}", snapshot.branch),
            InspectorAction::ToggleGitBranchMenu,
            state.panel.disabled,
        )
        .accessibility_label(format!("Branch, currently {}", snapshot.branch)),
    );
    if snapshot.ahead > 0 || snapshot.behind > 0 {
        top = top.child(muted(
            theme,
            format!("↑{} ↓{}", snapshot.ahead, snapshot.behind),
        ));
    }
    top = top
        .child(muted(
            theme,
            snapshot.head.chars().take(7).collect::<String>(),
        ))
        .child(div().flex_1())
        .child(action_button(
            &callbacks,
            "git-open-folder",
            "Open",
            InspectorAction::OpenGit,
            state.panel.disabled,
        ));
    root = root.child(top);
    if state.branch_open {
        let mut menu = v_flex()
            .id("git-branch-menu")
            .gap(theme.spacing.s1)
            .p(theme.spacing.s2)
            .bg(theme.colors.surface_2)
            .border_1()
            .border_color(theme.colors.border_strong)
            .role(Role::ListBox)
            .aria_label("Branch");
        let close_menu = callbacks.clone();
        menu = menu.on_key_down(move |event, _, _| {
            if event.keystroke.key == "escape" {
                close_menu.emit(InspectorAction::ToggleGitBranchMenu);
            }
        });
        for branch in &snapshot.branches {
            let callback = callbacks.clone();
            let branch_id = branch.clone();
            menu = menu.child(
                Button::new(format!("git-branch-{}", branch))
                    .ghost()
                    .small()
                    .w_full()
                    .justify_start()
                    .selected(branch == &snapshot.branch)
                    .role(Role::ListBoxOption)
                    .accessibility_label(branch.clone())
                    .child(branch.clone())
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::SelectGitBranch(branch_id.clone()))
                    }),
            );
        }
        if state.naming {
            menu = menu.child(
                h_flex()
                    .gap(theme.spacing.s2)
                    .child(input_value(
                        inputs.git_branch.as_ref(),
                        "git-new-branch",
                        &state.draft_branch,
                        "New branch name",
                        state.panel.busy || state.panel.disabled,
                        theme,
                    ))
                    .child(action_button(
                        &callbacks,
                        "git-create-branch",
                        "Create",
                        InspectorAction::NewGitBranch {
                            branch: state.draft_branch.clone(),
                            from: state.base.clone(),
                        },
                        state.panel.busy
                            || state.panel.disabled
                            || state.draft_branch.trim().is_empty(),
                    )),
            );
        } else {
            menu = menu.child(action_button(
                &callbacks,
                "git-new-branch",
                "New branch…",
                InspectorAction::NewGitBranch {
                    branch: String::new(),
                    from: snapshot.branch.clone(),
                },
                state.panel.busy || state.panel.disabled,
            ));
        }
        root = root.child(menu);
    }
    let mut tabs = h_flex()
        .id("git-view-tabs")
        .gap(theme.spacing.s1)
        .role(Role::TabList)
        .aria_label("Git views");
    for (view, label) in [(GitView::Changes, "Changes"), (GitView::Console, "Console")] {
        let callback = callbacks.clone();
        tabs = tabs.child(
            Button::new(format!("git-view-{}", label.to_ascii_lowercase()))
                .ghost()
                .small()
                .selected(state.view == view)
                .role(Role::Tab)
                .label(label)
                .on_click(move |_, _, _| {
                    callback.emit(InspectorAction::SelectGitView(label.to_ascii_lowercase()))
                }),
        );
    }
    root = root.child(tabs);
    let mut body = h_flex()
        .w_full()
        .items_start()
        .gap(theme.spacing.s4)
        .flex_1()
        .min_h_0();
    let mut side = v_flex()
        .id("git-page-side")
        .w(px(260.))
        .flex_none()
        .min_h_0()
        .gap(theme.spacing.s2);
    let files = snapshot
        .files
        .iter()
        .filter(|file| matches_git_filter(&state.panel.filter, &file.path))
        .collect::<Vec<_>>();
    side = side.child(input_value(
        inputs.git_filter.as_ref(),
        "git-page-filter",
        &state.panel.filter,
        "Filter changed files",
        state.panel.busy || state.panel.disabled,
        theme,
    ));
    side = side.child(muted(theme, format!("{} changed", snapshot.files.len())));
    if files.is_empty() {
        side = side.child(muted(theme, "No file matches that filter"));
    }
    let no_files = files.is_empty();
    for file in &files {
        let callback = callbacks.clone();
        let file_path = file.path.clone();
        let included = !state.panel.excluded.iter().any(|path| path == &file.path);
        side = side.child(
            Button::new(format!("git-side-file-{}", file.path))
                .ghost()
                .small()
                .w_full()
                .justify_start()
                .selected(included)
                .accessibility_label(format!(
                    "{} {}",
                    if included { "Included" } else { "Excluded" },
                    file.path
                ))
                .child(
                    h_flex()
                        .gap(theme.spacing.s2)
                        .child(if included { "☑" } else { "☐" })
                        .child(file_mark(theme, &file.path))
                        .child(div().flex_1().min_w_0().child(file.path.clone()))
                        .child(change_count(theme, file.added, file.removed)),
                )
                .on_click(move |_, _, _| {
                    callback.emit(InspectorAction::ToggleGitFile(file_path.clone()))
                }),
        );
    }
    let mut history = v_flex()
        .id("git-page-history")
        .max_h(px(220.))
        .gap(theme.spacing.s1)
        .overflow_y_scrollbar()
        .child(header(theme, "history"));
    if state.commits.is_empty() {
        history = history.child(muted(theme, "No commits yet"));
    } else {
        for (index, commit) in state.commits.iter().enumerate() {
            history = history.child(
                h_flex()
                    .id(format!("git-commit-{}", commit.hash))
                    .items_start()
                    .gap(theme.spacing.s2)
                    .child(
                        v_flex()
                            .w(px(18.))
                            .items_center()
                            .child(
                                div()
                                    .w(px(7.))
                                    .h(px(7.))
                                    .rounded(theme.radii.full)
                                    .bg(theme.colors.accent),
                            )
                            .when(index + 1 < state.commits.len(), |column| {
                                column.child(div().w(px(1.)).h(px(20.)).bg(theme.colors.border))
                            }),
                    )
                    .child(
                        v_flex()
                            .min_w_0()
                            .gap(theme.spacing.s1)
                            .child(text_value(theme, commit.subject.clone()))
                            .child(muted(
                                theme,
                                format!(
                                    "{} · {}{}",
                                    commit.hash.chars().take(7).collect::<String>(),
                                    commit.author,
                                    if commit.refs.is_empty() {
                                        String::new()
                                    } else {
                                        format!(" · {}", commit.refs.join(", "))
                                    }
                                ),
                            )),
                    ),
            );
        }
    }
    if state.more_history {
        history = history.child(action_button(
            &callbacks,
            "git-history-more",
            "Load more",
            InspectorAction::MoreGitHistory,
            state.panel.busy || state.panel.disabled,
        ));
    }
    side = side.child(history);
    side = side.child(
        h_flex()
            .gap(theme.spacing.s2)
            .child(action_button(
                &callbacks,
                "git-discard",
                "Discard",
                InspectorAction::DiscardGitFiles,
                state.panel.busy || state.panel.disabled || no_files,
            ))
            .child(action_button(
                &callbacks,
                "git-all-files",
                "All",
                InspectorAction::ToggleAllGitFiles(true),
                state.panel.busy || state.panel.disabled,
            )),
    );
    side = side.child(textarea_value(
        inputs.git_message.as_ref(),
        "git-commit-message",
        &state.message,
        "Commit message",
        80.,
        state.panel.busy || state.panel.disabled,
        theme,
    ));
    side = side.child(
        h_flex()
            .items_center()
            .gap(theme.spacing.s2)
            .child(action_button(
                &callbacks,
                "git-amend",
                if state.amend { "amend ✓" } else { "amend" },
                InspectorAction::ToggleGitAmend,
                state.panel.busy || state.panel.disabled,
            ))
            .child(action_button(
                &callbacks,
                "git-write-message",
                "Write message",
                InspectorAction::WriteGitMessage,
                state.panel.busy || state.panel.disabled || !state.message.trim().is_empty(),
            ))
            .child(primary_button(
                &callbacks,
                "git-commit",
                "Commit",
                InspectorAction::CommitGit {
                    message: state.message.clone(),
                    amend: state.amend,
                },
                state.panel.busy || state.panel.disabled || state.message.trim().is_empty(),
            )),
    );
    body = body.child(side);
    let mut main = v_flex()
        .id("git-page-main")
        .flex_1()
        .min_w_0()
        .min_h_0()
        .gap(theme.spacing.s2);
    if state.view == GitView::Changes {
        let mut diff = v_flex()
            .id("git-page-diff")
            .gap(theme.spacing.s2)
            .flex_1()
            .min_h_0()
            .overflow_y_scrollbar();
        for file in snapshot
            .diff_files
            .iter()
            .filter(|file| matches_git_filter(&state.panel.filter, &file.path))
        {
            diff = diff.child(render_git_file(
                file,
                theme,
                &callbacks,
                state.panel.disabled,
            ));
        }
        if snapshot.diff_files.is_empty() {
            diff = diff.child(muted(theme, "Working tree clean."));
        } else if !snapshot
            .diff_files
            .iter()
            .any(|file| matches_git_filter(&state.panel.filter, &file.path))
        {
            diff = diff.child(muted(theme, "No file matches that filter."));
        }
        main = main.child(diff);
    } else {
        main = main.child(input_value(
            inputs.git_command.as_ref(),
            "git-command",
            &state.command,
            "git command",
            state.panel.busy || state.panel.disabled,
            theme,
        ));
        main = main.child(h_flex().justify_end().child(action_button(
            &callbacks,
            "git-run",
            "Run",
            InspectorAction::RunGit(state.command.clone()),
            state.panel.busy || state.panel.disabled || state.command.trim().is_empty(),
        )));
        main = main.child(
            div()
                .flex_1()
                .min_h_0()
                .overflow_y_scrollbar()
                .p(theme.spacing.s3)
                .bg(theme.colors.surface_2)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_2xs)
                .child(if state.output.is_empty() {
                    "".to_owned()
                } else {
                    state.output.clone()
                }),
        );
    }
    body = body.child(main);
    root.child(body)
}

fn render_git_file(
    file: &GitFileSnapshot,
    theme: &EmmaTheme,
    callbacks: &InspectorCallbacks,
    disabled: bool,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id(format!("git-full-file-{}", file.path))
        .gap(theme.spacing.s2)
        .p(theme.spacing.s2)
        .border_1()
        .border_color(theme.colors.border)
        .child(
            h_flex()
                .items_center()
                .gap(theme.spacing.s2)
                .child(file_mark(theme, &file.path))
                .child(div().flex_1().min_w_0().child(file.path.clone()))
                .child(change_count(theme, file.added, file.removed))
                .child(muted(theme, git_file_state(file))),
        );
    let open = action_button(
        callbacks,
        format!("git-full-open-{}", file.path),
        "Open",
        InspectorAction::OpenGitFile(file.path.clone()),
        disabled,
    );
    root = root.child(h_flex().justify_end().child(open));
    if !file.lines.is_empty() {
        let mut diff = v_flex()
            .id(format!("git-full-diff-{}", file.path))
            .max_h(px(600.))
            .overflow_y_scrollbar()
            .p(theme.spacing.s2)
            .bg(theme.colors.surface_2)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_2xs);
        for (index, line) in file.lines.iter().enumerate() {
            diff = diff.child(
                div()
                    .id(format!("git-full-line-{}-{}", file.path, index))
                    .text_color(match line.kind {
                        '+' => theme.colors.lime,
                        '-' => theme.colors.rose,
                        '@' => theme.colors.violet,
                        _ => theme.colors.text_2,
                    })
                    .child(format!("{}{}", line.kind, line.text)),
            );
        }
        root = root.child(diff);
    }
    root
}

fn render_cli(
    state: &CliRunState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let working = state.status == "running";
    let mut root = v_flex()
        .id(format!("cli-panel-{}", state.id))
        .size_full()
        .min_w_0()
        .bg(theme.colors.bg)
        .role(Role::Region)
        .aria_label(format!("{} run {}", state.label, state.id));
    if let Some(status) = status_panel(&state_error_status(state), theme) {
        root = root.child(status);
    }
    let status = if working {
        "working"
    } else if state.status == "failed" {
        "failed"
    } else if state.exit_code.unwrap_or(0) == 0 {
        "finished"
    } else {
        "stopped"
    };
    let mut bar = h_flex()
        .flex_none()
        .items_center()
        .justify_between()
        .min_h(theme.dimensions.thread_bar_height)
        .px(theme.spacing.s4)
        .border_b_1()
        .border_color(theme.colors.border)
        .child(
            h_flex()
                .items_center()
                .gap(theme.spacing.s2)
                .child(div().text_color(theme.colors.accent).child("⌘"))
                .child(text_value(theme, state.label.clone())),
        );
    let mut bar_actions = h_flex().items_center().gap(theme.spacing.s2).child(muted(
        theme,
        if working {
            format!("{status} · active")
        } else {
            status.to_owned()
        },
    ));
    bar_actions = bar_actions.child(action_button(
        &callbacks,
        format!("cli-float-{}", state.id),
        "Float",
        InspectorAction::FloatCli(state.id.clone()),
        state.disabled,
    ));
    if working {
        bar_actions = bar_actions.child(action_button(
            &callbacks,
            format!("cli-stop-{}", state.id),
            "Stop",
            InspectorAction::StopCli(state.id.clone()),
            state.busy || state.disabled,
        ));
    }
    bar = bar.child(bar_actions);
    root = root.child(bar);
    root = root.child(
        h_flex()
            .w_full()
            .flex_wrap()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .child(cli_stat(theme, "Run", state.id.clone()))
            .child(cli_stat(
                theme,
                "Folder",
                if state.folder.is_empty() {
                    state.cwd.clone()
                } else {
                    state.folder.clone()
                },
            ))
            .child(cli_stat(theme, "Turns", state.turns.to_string()))
            .child(cli_stat(
                theme,
                "Approvals",
                if state.unattended {
                    "skipped".to_owned()
                } else {
                    "CLI default".to_owned()
                },
            )),
    );
    if !state.owns_session {
        root = root.child(muted(
            theme,
            format!(
                "{} continues the newest session in this folder; keep one going at a time.",
                state.label
            ),
        ));
    }
    if !state.models.is_empty() || state.models_open {
        root = root.child(render_cli_models(state, theme, callbacks.clone()));
    }
    if state.output.is_empty() {
        root = root.child(muted(theme, "Waiting for output…"));
    } else {
        root = root.child(
            div()
                .id(format!("cli-terminal-{}", state.id))
                .flex_1()
                .min_h_0()
                .overflow_y_scrollbar()
                .mx(theme.spacing.s4)
                .p(theme.spacing.s3)
                .bg(theme.colors.surface_2)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_2xs)
                .child(state.output.clone()),
        );
    }
    let mut composer = v_flex()
        .id(format!("cli-composer-{}", state.id))
        .flex_none()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s4)
        .border_t_1()
        .border_color(theme.colors.border)
        .child(textarea_value(
            inputs.cli_message.as_ref(),
            format!("cli-message-{}", state.id),
            &state.message,
            format!("Message {}", state.label),
            64.,
            state.busy || working || state.disabled,
            theme,
        ));
    if !state.attachments.is_empty() {
        let mut attachments = h_flex().gap(theme.spacing.s2);
        for attachment in &state.attachments {
            attachments = attachments.child(
                action_button(
                    &callbacks,
                    format!("cli-attachment-{}", attachment.id),
                    attachment.name.clone(),
                    InspectorAction::RemoveCliAttachment(attachment.id.clone()),
                    state.disabled,
                )
                .tooltip(format!("Remove {}", attachment.path)),
            );
        }
        composer = composer.child(attachments);
    }
    composer = composer.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(
                action_button(
                    &callbacks,
                    format!("cli-attach-{}", state.id),
                    "＋",
                    InspectorAction::AttachCli(state.id.clone()),
                    working || state.disabled,
                )
                .accessibility_label("Attach files"),
            )
            .child(primary_button(
                &callbacks,
                format!("cli-send-{}", state.id),
                "↑",
                InspectorAction::SendCli {
                    id: state.id.clone(),
                    prompt: state.message.trim().to_owned(),
                    attachments: state
                        .attachments
                        .iter()
                        .map(|attachment| attachment.id.clone())
                        .collect(),
                },
                working || state.busy || state.disabled || state.message.trim().is_empty(),
            )),
    );
    if let Some(error) = &state.error {
        composer = composer.child(
            div()
                .id("cli-error")
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    root.child(composer)
}

fn state_error_status(state: &CliRunState) -> InspectorStatus {
    if let Some(error) = &state.error {
        InspectorStatus::Error(error.clone())
    } else {
        InspectorStatus::Ready
    }
}

fn cli_stat(theme: &EmmaTheme, label: &str, value: String) -> Div {
    v_flex()
        .min_w(px(90.))
        .gap(theme.spacing.s1)
        .child(muted(theme, label))
        .child(text_value(theme, value))
}

fn render_cli_models(
    state: &CliRunState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id(format!("cli-models-{}", state.id))
        .gap(theme.spacing.s2)
        .px(theme.spacing.s4)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(muted(
                    theme,
                    if let Some(at) = state.models_at {
                        format!("{} models · read {}", state.models.len(), at)
                    } else {
                        "Asking the CLI what models it has…".to_owned()
                    },
                ))
                .child(action_button(
                    &callbacks,
                    format!("cli-models-toggle-{}", state.id),
                    if state.models_open { "Close" } else { "Model" },
                    InspectorAction::ToggleCliModels(state.id.clone()),
                    state.disabled,
                )),
        );
    if state.models_open {
        if state.models.is_empty() {
            root = root.child(muted(theme, "No models reported by this CLI."));
        } else {
            for model in &state.models {
                let callback = callbacks.clone();
                let model_id = model.clone();
                root = root.child(
                    action_button(
                        &callback,
                        format!("cli-model-{}-{}", state.id, model),
                        model_id.clone(),
                        InspectorAction::SelectCliModel {
                            id: state.id.clone(),
                            model: model_id.clone(),
                        },
                        state.disabled,
                    )
                    .selected(state.model.as_deref() == Some(model.as_str())),
                );
            }
        }
        root = root.child(action_button(
            &callbacks,
            format!("cli-model-refresh-{}", state.id),
            "Reread models",
            InspectorAction::RefreshCliModels(state.id.clone()),
            state.models_busy || state.disabled,
        ));
    }
    root
}

fn render_harness(
    state: &HarnessSurfaceState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let health_label = match state.health {
        HarnessHealth::Ready => "Agent ready",
        HarnessHealth::Online => "Agent online",
        HarnessHealth::Stalled => "Agent stalled",
        HarnessHealth::Offline => "Agent offline",
    };
    let advice = match state.health {
        HarnessHealth::Ready => "No emma-cli process is running. The next turn starts one.",
        HarnessHealth::Online => "emma-cli is up and answering.",
        HarnessHealth::Stalled => {
            "A turn is in flight but emma-cli has said nothing for over 2 minutes. Stop the turn, or restart the agent."
        }
        HarnessHealth::Offline => {
            "emma-cli stopped. Restart it; if it dies again, hand the fix prompt to another agent."
        }
    };
    let mut root = v_flex()
        .id("inspector-harness")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s4)
        .bg(theme.colors.surface)
        .role(Role::Dialog)
        .aria_label("Emma agent status");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(
        h_flex().items_center().justify_between().child(
            v_flex()
                .gap(theme.spacing.s1)
                .child(muted(theme, "emma-cli · ACP"))
                .child(text_value(theme, health_label)),
        ),
    );
    let mut processes = v_flex().gap(theme.spacing.s1);
    if state.processes.is_empty() {
        processes = processes.child(muted(theme, "Processes · None — the next turn starts one"));
    } else {
        for process in &state.processes {
            processes = processes.child(
                v_flex()
                    .gap(theme.spacing.s1)
                    .p(theme.spacing.s2)
                    .bg(theme.colors.surface_2)
                    .child(text_value(theme, process_folder(&process.cwd)))
                    .child(muted(
                        theme,
                        format!(
                            "{} · {} · {}{}",
                            if process.running {
                                "running"
                            } else {
                                "stopped"
                            },
                            if process.busy {
                                "turn in flight"
                            } else {
                                "idle"
                            },
                            silence(process.silent_ms),
                            process
                                .failure
                                .as_ref()
                                .map(|failure| format!(" · {failure}"))
                                .unwrap_or_default()
                        ),
                    )),
            );
        }
    }
    root = root.child(processes);
    if state.health != HarnessHealth::Online {
        root = root.child(
            div()
                .id("harness-health-advice")
                .text_color(if state.health == HarnessHealth::Ready {
                    theme.colors.text_2
                } else {
                    theme.colors.danger
                })
                .role(if state.health == HarnessHealth::Ready {
                    Role::Status
                } else {
                    Role::Alert
                })
                .child(advice),
        );
    }
    let mut filters = h_flex()
        .id("harness-filters")
        .items_center()
        .gap(theme.spacing.s1)
        .role(Role::Group)
        .aria_label("Filter wire traffic");
    for (flow, label) in [
        (HarnessFlow::All, "All"),
        (HarnessFlow::Out, "Emma → agent"),
        (HarnessFlow::In, "Agent → Emma"),
        (HarnessFlow::Err, "Process"),
    ] {
        let callback = callbacks.clone();
        filters = filters.child(
            action_button(
                &callback,
                format!("harness-flow-{label}"),
                label,
                InspectorAction::FilterHarness(harness_flow_id(flow).to_owned()),
                state.disabled,
            )
            .selected(state.flow == flow),
        );
    }
    let lines = state
        .lines
        .iter()
        .filter(|line| {
            state.flow == HarnessFlow::All || harness_flow_matches(state.flow, &line.flow)
        })
        .collect::<Vec<_>>();
    filters = filters.child(muted(theme, format!("{} messages", lines.len())));
    root = root.child(filters);
    let mut log = v_flex()
        .id("harness-lines")
        .max_h(px(420.))
        .gap(theme.spacing.s1)
        .overflow_y_scrollbar();
    if lines.is_empty() {
        log = log.child(muted(
            theme,
            "Nothing on the wire yet. Streamed answer chunks are left out; everything else Emma sends or reads lands here.",
        ));
    }
    for line in lines {
        let callback = callbacks.clone();
        let line_id = line.id.clone();
        let mut detail = v_flex()
            .id(format!("harness-line-{}", line.id))
            .gap(theme.spacing.s1)
            .p(theme.spacing.s2)
            .bg(theme.colors.surface_2)
            .child(
                Button::new(format!("harness-line-toggle-{}", line.id))
                    .ghost()
                    .small()
                    .w_full()
                    .justify_start()
                    .accessibility_label(format!("{} {}", line.label, line.body.len()))
                    .child(
                        h_flex()
                            .w_full()
                            .gap(theme.spacing.s2)
                            .child(muted(theme, clock(line.at)))
                            .child(text_value(theme, line.label.clone()))
                            .child(muted(theme, format!("{} chars", line.body.len()))),
                    )
                    .on_click(move |_, _, _| {
                        callback.emit(InspectorAction::ToggleHarnessLine(line_id.clone()))
                    }),
            );
        if state
            .expanded_line
            .as_deref()
            .map_or(state.open, |expanded| expanded == line.id)
        {
            detail = detail.child(
                div()
                    .max_h(px(240.))
                    .overflow_y_scrollbar()
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_2xs)
                    .child(line.body.clone()),
            );
        }
        log = log.child(detail);
    }
    root = root.child(log);
    if let Some(error) = &state.error {
        root = root.child(
            div()
                .id("harness-error")
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    root.child(
        h_flex()
            .justify_end()
            .gap(theme.spacing.s2)
            .child(primary_button(
                &callbacks,
                "harness-restart",
                if state.busy {
                    "Restarting…"
                } else {
                    "Restart agent"
                },
                InspectorAction::RestartHarness,
                state.busy || state.disabled,
            ))
            .child(action_button(
                &callbacks,
                "harness-copy",
                if state.copied {
                    "Copied"
                } else {
                    "Copy fix prompt"
                },
                InspectorAction::CopyHarnessFixPrompt,
                state.disabled,
            )),
    )
}

pub fn render_harness_status(
    state: &HarnessSurfaceState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Button {
    let label = match state.health {
        HarnessHealth::Ready => "Agent ready",
        HarnessHealth::Online => "Agent online",
        HarnessHealth::Stalled => "Agent stalled",
        HarnessHealth::Offline => "Agent offline",
    };
    action_button(
        &callbacks,
        "harness-status",
        label,
        InspectorAction::OpenHarness,
        state.disabled,
    )
    .text_color(match state.health {
        HarnessHealth::Ready => theme.colors.text_2,
        HarnessHealth::Online => theme.colors.teal,
        HarnessHealth::Stalled | HarnessHealth::Offline => theme.colors.danger,
    })
    .accessibility_label(label)
    .tooltip(match state.health {
        HarnessHealth::Ready => "No emma-cli process is running. The next turn starts one.",
        HarnessHealth::Online => "emma-cli is up and answering.",
        HarnessHealth::Stalled => {
            "A turn is in flight but emma-cli has said nothing for over 2 minutes."
        }
        HarnessHealth::Offline => "emma-cli stopped. Restart it or copy the fix prompt.",
    })
}

fn process_folder(cwd: &str) -> String {
    cwd.rsplit(['/', '\\'])
        .find(|part| !part.is_empty())
        .unwrap_or(cwd)
        .to_owned()
}

fn silence(ms: u64) -> String {
    if ms == 0 {
        "never spoke".to_owned()
    } else if ms < 1_000 {
        "heard just now".to_owned()
    } else {
        format!("heard {}s ago", ms / 1_000)
    }
}

fn clock(at: u64) -> String {
    let seconds = (at / 1_000) % 86_400;
    format!(
        "{:02}:{:02}:{:02}",
        seconds / 3_600,
        (seconds / 60) % 60,
        seconds % 60
    )
}

fn goal_status_label(status: &str) -> &'static str {
    match status {
        "active" => "Active",
        "paused" => "Paused",
        "blocked" => "Blocked",
        "usageLimited" => "Usage limited",
        "budgetLimited" => "Budget limited",
        "completed" => "Completed",
        "cleared" => "Cleared",
        _ => "None",
    }
}

fn harness_flow_id(flow: HarnessFlow) -> &'static str {
    match flow {
        HarnessFlow::All => "all",
        HarnessFlow::Out => "out",
        HarnessFlow::In => "in",
        HarnessFlow::Err => "err",
    }
}

fn harness_flow_matches(flow: HarnessFlow, value: &str) -> bool {
    harness_flow_id(flow) == value
}

fn render_goal(
    state: &GoalSurfaceState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id(format!("goal-view-{}", state.thread_id))
        .size_full()
        .min_w_0()
        .bg(theme.colors.bg)
        .role(Role::Region)
        .aria_label("Goal");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(
        header(theme, "Goal").child(
            state
                .goal_status
                .as_ref()
                .map(|status| muted(theme, goal_status_label(status)))
                .unwrap_or_else(|| muted(theme, goal_status_label("none"))),
        ),
    );
    let Some(objective) = &state.objective else {
        return root.child(muted(theme, "This thread has no goal."));
    };
    root = root.child(
        div()
            .p(theme.spacing.s4)
            .text_size(theme.typography.fs_lg)
            .child(objective.clone()),
    );
    let left = state.token_budget.saturating_sub(state.tokens_used);
    let ratio = if state.token_budget == 0 {
        0.
    } else {
        (state.tokens_used as f32 / state.token_budget as f32).clamp(0., 1.)
    };
    let ledger = v_flex()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .bg(theme.colors.surface_2)
        .child(
            div().relative().h(px(8.)).bg(theme.colors.surface_3).child(
                div()
                    .absolute()
                    .left_0()
                    .h(px(8.))
                    .w(relative(ratio))
                    .bg(theme.colors.accent),
            ),
        )
        .child(
            h_flex()
                .flex_wrap()
                .gap(theme.spacing.s3)
                .child(muted(theme, format!("Budget · {}", state.token_budget)))
                .child(muted(theme, format!("Spent · {}", state.tokens_used)))
                .child(muted(theme, format!("Left · {left}")))
                .child(muted(
                    theme,
                    format!("Elapsed · {}s", state.time_used_seconds),
                ))
                .child(muted(
                    theme,
                    format!("Turns · {} of {}", state.turns, state.max_turns),
                ))
                .child(muted(theme, format!("Started · {}", state.created_at))),
        );
    root = root.child(ledger);
    let active = state.goal_status.as_deref() == Some("active");
    let resumable = matches!(
        state.goal_status.as_deref(),
        Some("paused") | Some("blocked") | Some("usageLimited") | Some("active")
    );
    let mut controls = h_flex().gap(theme.spacing.s2);
    if active {
        controls = controls.child(action_button(
            &callbacks,
            format!("goal-pause-{}", state.thread_id),
            "Pause",
            InspectorAction::PauseGoal(state.thread_id.clone()),
            state.busy || state.disabled,
        ));
    }
    if resumable {
        controls = controls.child(action_button(
            &callbacks,
            format!("goal-resume-{}", state.thread_id),
            "Resume",
            InspectorAction::ResumeGoal(state.thread_id.clone()),
            state.busy || state.disabled,
        ));
    }
    if state.goal_status.as_deref() == Some("budgetLimited") || left == 0 {
        controls = controls.child(primary_button(
            &callbacks,
            format!("goal-continue-{}", state.thread_id),
            "Continue · +200K",
            InspectorAction::ContinueGoal(state.thread_id.clone()),
            state.busy || state.disabled,
        ));
    }
    controls = controls.child(action_button(
        &callbacks,
        format!("goal-clear-{}", state.thread_id),
        "Clear",
        InspectorAction::ClearGoal(state.thread_id.clone()),
        state.busy || state.disabled,
    ));
    root = root.child(controls);
    if let Some(reason) = &state.blocked_reason {
        root = root.child(
            panel(theme, "blocker")
                .child(text_value(
                    theme,
                    format!(
                        "Blocker {} of {}",
                        state.blocked_streak.max(1),
                        state.blocked_limit
                    ),
                ))
                .child(text_value(theme, reason.clone())),
        );
    }
    if let Some(evidence) = &state.evidence {
        root = root.child(
            panel(theme, "evidence")
                .child(text_value(theme, "Evidence"))
                .child(text_value(theme, evidence.clone())),
        );
    }
    if !state.revisions.is_empty() {
        let mut revisions = panel(theme, "goal-revisions").child(text_value(theme, "Revisions"));
        for (index, revision) in state.revisions.iter().enumerate() {
            revisions = revisions.child(
                h_flex()
                    .id(format!("goal-revision-{index}"))
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(muted(theme, revision.at.clone()))
                    .child(muted(
                        theme,
                        format!("{} {}", revision.steps, plural(revision.steps, "step")),
                    ))
                    .child(muted(
                        theme,
                        format!(
                            "+{} ~{} -{}",
                            revision.added.len(),
                            revision.rewritten.len(),
                            revision.removed.len()
                        ),
                    )),
            );
        }
        root = root.child(revisions);
    }
    if !state.plan.is_empty() {
        let mut plan = panel(theme, "goal-plan").child(text_value(theme, "Plan"));
        for step in &state.plan {
            let callback = callbacks.clone();
            plan = plan.child(
                action_button(
                    &callback,
                    format!("goal-step-{}", step.id),
                    format!("{} · {}", step.title, step.status),
                    InspectorAction::OpenGoalThread(step.id.clone()),
                    state.disabled,
                )
                .tooltip(if step.needs.is_empty() {
                    step.result.clone().unwrap_or_default()
                } else {
                    format!("waits on {}", step.needs.join(", "))
                }),
            );
        }
        root = root.child(plan);
    }
    if !state.agents.is_empty() {
        let mut agents = panel(theme, "goal-agents").child(text_value(theme, "Working on it"));
        for agent in &state.agents {
            let callback = callbacks.clone();
            agents = agents.child(
                action_button(
                    &callback,
                    format!("goal-agent-{}", agent.id),
                    format!("{} · {}", agent.title, agent.status),
                    InspectorAction::OpenGoalThread(agent.id.clone()),
                    state.disabled,
                )
                .accessibility_label(format!("{} — {}", agent.title, agent.activity)),
            );
        }
        root = root.child(agents);
    }
    if let Some(error) = &state.error {
        root = root.child(
            div()
                .id(format!("goal-error-{}", state.thread_id))
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    root
}

pub fn render_goal_card(
    state: &GoalSurfaceState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Button {
    let objective = state
        .objective
        .clone()
        .unwrap_or_else(|| "No goal".to_owned());
    let left = state.token_budget.saturating_sub(state.tokens_used);
    let ratio = if state.token_budget == 0 {
        0.
    } else {
        (state.tokens_used as f32 / state.token_budget as f32).clamp(0., 1.)
    };
    let thread_id = state.thread_id.clone();
    Button::new(format!("goal-card-{}", state.thread_id))
        .ghost()
        .w_full()
        .justify_start()
        .disabled(state.disabled)
        .accessibility_label(format!(
            "{}: {}. {} of {} tokens spent over {} {}. Open the goal.",
            goal_status_label(state.goal_status.as_deref().unwrap_or("none")),
            objective,
            state.tokens_used,
            state.token_budget,
            state.turns,
            plural(state.turns, "turn")
        ))
        .child(
            v_flex()
                .w_full()
                .gap(theme.spacing.s2)
                .child(
                    h_flex()
                        .items_center()
                        .gap(theme.spacing.s2)
                        .child(muted(
                            theme,
                            goal_status_label(state.goal_status.as_deref().unwrap_or("none")),
                        ))
                        .child(text_value(theme, objective)),
                )
                .child(
                    div().relative().h(px(6.)).bg(theme.colors.surface_3).child(
                        div()
                            .absolute()
                            .left_0()
                            .h(px(6.))
                            .w(relative(ratio))
                            .bg(theme.colors.accent),
                    ),
                )
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap(theme.spacing.s2)
                        .child(muted(theme, format!("{} spent", state.tokens_used)))
                        .child(muted(theme, format!("{left} left")))
                        .child(muted(theme, format!("{}s", state.time_used_seconds)))
                        .child(muted(
                            theme,
                            format!("{} of {} turns", state.turns, state.max_turns),
                        )),
                ),
        )
        .on_click(move |_, _, _| callbacks.emit(InspectorAction::OpenGoalThread(thread_id.clone())))
}

fn render_activity(
    state: &ActivitySurfaceState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
) -> Stateful<Div> {
    let mut root = v_flex()
        .id("inspector-activity")
        .size_full()
        .min_w_0()
        .gap(theme.spacing.s4)
        .p(theme.spacing.s4)
        .bg(theme.colors.bg)
        .role(Role::Region)
        .aria_label("Agent activity");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    let metrics = [
        (state.live_threads, "live thread"),
        (state.turns, "turn asked"),
        (state.subagents, "subagent spawned"),
        (state.streak, "day streak"),
    ];
    let mut metric_row = h_flex().w_full().flex_wrap().gap(theme.spacing.s2);
    for (index, (value, label)) in metrics.into_iter().enumerate() {
        metric_row = metric_row.child(
            v_flex()
                .id(format!("activity-metric-{index}"))
                .flex_1()
                .min_w(px(140.))
                .gap(theme.spacing.s1)
                .p(theme.spacing.s3)
                .bg(theme.colors.surface)
                .border_1()
                .border_color(theme.colors.border)
                .child(
                    div()
                        .text_size(theme.typography.fs_2xl)
                        .child(value.to_string()),
                )
                .child(muted(theme, format!("{} {}", value, plural(value, label)))),
        );
    }
    root = root.child(metric_row);
    let total = state.days.iter().map(|day| day.count).sum::<usize>();
    let active = state.days.iter().filter(|day| day.count > 0).count();
    let peak = state.days.iter().map(|day| day.count).max().unwrap_or(1);
    let mut heat = v_flex()
        .gap(theme.spacing.s2)
        .p(theme.spacing.s3)
        .bg(theme.colors.surface)
        .border_1()
        .border_color(theme.colors.border)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(text_value(theme, "Every day"))
                .child(muted(
                    theme,
                    format!(
                        "{} messages · {} active days · {} day streak",
                        total, active, state.streak
                    ),
                )),
        );
    let mut cells = h_flex().flex_wrap().gap(theme.spacing.s1);
    for day in &state.days {
        cells = cells.child(
            div()
                .id(format!("activity-day-{}", day.key))
                .w(px(10.))
                .h(px(10.))
                .bg(activity_cell_color(day.count, peak, theme))
                .aria_label(format!("{} · {} messages", day.key, day.count)),
        );
    }
    if state.days.is_empty() {
        cells = cells.child(muted(theme, "No activity yet."));
    }
    heat = heat.child(cells).child(
        h_flex()
            .justify_end()
            .gap(theme.spacing.s2)
            .child(action_button(
                &callbacks,
                "activity-span",
                if state.span == ActivitySpan::Week {
                    "Year"
                } else {
                    "Week"
                },
                InspectorAction::ToggleActivitySpan,
                state.disabled,
            ))
            .child(action_button(
                &callbacks,
                "activity-history",
                "All time",
                InspectorAction::OpenActivityHistory,
                state.disabled,
            )),
    );
    root = root.child(heat);
    let started_peak = state.started.iter().map(|day| day.count).max().unwrap_or(1);
    let started = panel(theme, "activity-started").child(
        h_flex()
            .justify_between()
            .child(text_value(theme, "Threads started"))
            .child(muted(theme, format!("Peak {started_peak}/day"))),
    );
    let mut bars = h_flex().h(px(52.)).items_end().gap(theme.spacing.s1);
    for day in &state.started {
        bars = bars.child(
            div()
                .id(format!("activity-started-{}", day.key))
                .w(px(6.))
                .h(px((day.count as f32 / started_peak as f32 * 48.).max(1.)))
                .bg(theme.colors.accent)
                .aria_label(format!("{} · {}", day.key, day.count)),
        );
    }
    if state.started.is_empty() {
        bars = bars.child(muted(theme, "No threads yet."));
    }
    root = root.child(started.child(bars));
    let mut projects = panel(theme, "activity-projects").child(
        h_flex()
            .justify_between()
            .child(text_value(theme, "Projects over time"))
            .child(muted(theme, state.projects.len().to_string())),
    );
    for project in &state.projects {
        let width = project
            .messages
            .saturating_mul(100)
            .checked_div(
                state
                    .projects
                    .iter()
                    .map(|item| item.messages)
                    .max()
                    .unwrap_or(1),
            )
            .unwrap_or(0);
        projects = projects.child(
            v_flex()
                .gap(theme.spacing.s1)
                .child(
                    h_flex()
                        .justify_between()
                        .child(text_value(theme, project.name.clone()))
                        .child(muted(theme, format!("{} messages", project.messages))),
                )
                .child(
                    div().h(px(6.)).bg(theme.colors.surface_3).child(
                        div()
                            .h(px(6.))
                            .w(relative(width as f32 / 100.))
                            .bg(theme.colors.teal),
                    ),
                )
                .child(muted(
                    theme,
                    format!("{} threads · last {}", project.threads, project.last_at),
                )),
        );
    }
    if state.projects.is_empty() {
        projects = projects.child(muted(theme, "No threads yet."));
    }
    root = root.child(projects);
    let mut lineage = panel(theme, "activity-lineage").child(
        h_flex()
            .justify_between()
            .child(text_value(theme, "Thread tree"))
            .child(muted(theme, format!("{} rows", state.lineage.len()))),
    );
    for row in &state.lineage {
        let callback = callbacks.clone();
        lineage = lineage.child(
            action_button(
                &callback,
                format!("activity-thread-{}", row.id),
                format!("{}{}", "  ".repeat(row.depth), row.title),
                InspectorAction::OpenActivityThread(row.id.clone()),
                state.disabled,
            )
            .accessibility_label(format!("{} · {}", row.title, row.meta)),
        );
    }
    if state.lineage.is_empty() {
        lineage = lineage.child(muted(theme, "No threads yet"));
    }
    root.child(lineage)
}

fn activity_cell_color(count: usize, peak: usize, theme: &EmmaTheme) -> gpui::Hsla {
    if count == 0 {
        theme.colors.surface_3
    } else if peak <= 1 || count.saturating_mul(4) >= peak.saturating_mul(3) {
        theme.colors.lime
    } else if count.saturating_mul(2) >= peak {
        theme.colors.teal
    } else {
        theme.colors.accent_soft
    }
}

fn plural(value: usize, singular: &str) -> String {
    if value == 1 {
        singular.to_owned()
    } else {
        format!("{singular}s")
    }
}

fn render_model_plans(
    state: &ModelPlansState,
    theme: &EmmaTheme,
    callbacks: InspectorCallbacks,
    inputs: &InspectorInputs,
) -> Stateful<Div> {
    let connected = state.plans.iter().filter(|plan| plan.connected).count();
    let mut root = v_flex()
        .id("inspector-model-plans")
        .w_full()
        .min_w_0()
        .gap(theme.spacing.s3)
        .p(theme.spacing.s4)
        .role(Role::Region)
        .aria_label("Subscriptions");
    if let Some(status) = status_panel(&state.status, theme) {
        root = root.child(status);
    }
    root = root.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(
                v_flex()
                    .gap(theme.spacing.s1)
                    .child(muted(theme, "Subscriptions"))
                    .child(text_value(
                        theme,
                        "Run a model on a plan you already pay for",
                    )),
            )
            .child(muted(theme, format!("{} connected", connected))),
    );
    if let Some(error) = &state.error {
        root = root.child(
            div()
                .id("model-plans-error")
                .text_color(theme.colors.danger)
                .role(Role::Alert)
                .child(error.clone()),
        );
    }
    if let Some(notice) = &state.notice {
        root = root.child(
            div()
                .id("model-plans-notice")
                .text_color(theme.colors.teal)
                .role(Role::Status)
                .child(notice.clone()),
        );
    }
    if state.plans.is_empty() {
        return root.child(muted(theme, "No model plans are available."));
    }
    for plan in &state.plans {
        let mut row = v_flex()
            .id(format!("model-plan-{}", plan.id))
            .gap(theme.spacing.s2)
            .p(theme.spacing.s3)
            .bg(theme.colors.surface)
            .border_1()
            .border_color(if plan.connected {
                theme.colors.teal
            } else {
                theme.colors.border
            })
            .child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(
                        div()
                            .w(px(24.))
                            .text_center()
                            .text_color(theme.colors.accent)
                            .child(plan.brand.chars().next().unwrap_or('M').to_string()),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .child(text_value(theme, plan.label.clone()))
                            .child(muted(theme, plan.detail.clone()))
                            .child(muted(theme, plan.note.clone()))
                            .child(muted(theme, plan.credential_env.clone())),
                    )
                    .child(muted(
                        theme,
                        if plan.routed_models.is_empty() {
                            "No models".to_owned()
                        } else {
                            plan.routed_models.join(", ")
                        },
                    )),
            );
        let mut controls = h_flex().items_center().gap(theme.spacing.s2);
        if plan.cli {
            controls = controls.child(action_button(
                &callbacks,
                format!("model-plan-signin-{}", plan.id),
                if plan.signed_in {
                    "Sign in again"
                } else {
                    "Sign in"
                },
                InspectorAction::SignInCli(plan.id.clone()),
                state.busy || state.disabled || !plan.installed,
            ));
            controls = controls.child(muted(
                theme,
                if !plan.installed {
                    "Not installed"
                } else if plan.signed_in {
                    "Signed in"
                } else {
                    "Not signed in"
                },
            ));
        } else {
            if !plan.keys_url.is_empty() {
                controls = controls.child(action_button(
                    &callbacks,
                    format!("model-plan-key-url-{}", plan.id),
                    "Get a key ↗",
                    InspectorAction::OpenModelKeyUrl {
                        plan_id: plan.id.clone(),
                        url: plan.keys_url.clone(),
                    },
                    state.disabled,
                ));
            }
            controls = controls
                .child(input_value(
                    inputs.model_key.as_ref(),
                    format!("model-plan-key-{}", plan.id),
                    &plan.key_value,
                    format!("{} API key", plan.label),
                    state.busy || state.disabled,
                    theme,
                ))
                .child(primary_button(
                    &callbacks,
                    format!("model-plan-save-{}", plan.id),
                    "Save key",
                    InspectorAction::SaveModelKey {
                        plan_id: plan.id.clone(),
                        secret: plan.key_value.clone(),
                    },
                    state.busy || state.disabled || plan.key_value.trim().is_empty(),
                ))
                .child(action_button(
                    &callbacks,
                    format!("model-plan-remove-{}", plan.id),
                    "Remove",
                    InspectorAction::RemoveModelKey(plan.id.clone()),
                    state.busy || state.disabled || !plan.connected,
                ));
        }
        row = row.child(controls);
        let spend = [
            plan.spend_5h.clone(),
            plan.spend_7d.clone(),
            plan.balance.clone(),
        ]
        .into_iter()
        .flatten()
        .collect::<Vec<_>>();
        if !spend.is_empty() {
            row = row.child(muted(theme, spend.join(" · ")));
        }
        root = root.child(row);
    }
    root
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn surface_ids_cover_native_inspector_contract() {
        let surfaces = [
            InspectorSurface::Mode(ModePickerState::default()),
            InspectorSurface::Permission(PermissionPromptState::default()),
            InspectorSurface::AgentRail(AgentRailState::default()),
            InspectorSurface::BackgroundRail(BackgroundRailState::default()),
            InspectorSurface::Tabs(TabStripState::default()),
            InspectorSurface::Changes(Box::new(ChangesPanelState {
                status: InspectorStatus::Empty,
                changes: Vec::new(),
                busy: false,
                error: None,
                disabled: false,
            })),
            InspectorSurface::Context(Box::default()),
            InspectorSurface::ContextSettings(Box::new(ContextSettingsState {
                status: InspectorStatus::Empty,
                pages: Vec::new(),
                active_page: String::new(),
                page_name: String::new(),
                widgets: Vec::new(),
                spare: Vec::new(),
                editing: false,
                adding: false,
                busy: false,
                disabled: false,
            })),
            InspectorSurface::Machine(Box::new(MachineSurfaceState {
                status: InspectorStatus::Empty,
                samples: Vec::new(),
                orientation: "vertical".to_owned(),
                view: MachineView::Stats,
                disabled: false,
            })),
        ];
        assert_eq!(
            surfaces
                .iter()
                .map(InspectorSurface::id)
                .collect::<Vec<_>>(),
            vec![
                "mode",
                "permission",
                "agent-rail",
                "background-rail",
                "tabs",
                "changes",
                "context",
                "context-settings",
                "machine",
            ]
        );
    }

    #[test]
    fn agent_snapshot_elapsed_and_speed_are_deterministic() {
        let agent = AgentSnapshot {
            id: "agent".to_owned(),
            parent_id: None,
            title: "Ada".to_owned(),
            color: "#ffffff".to_owned(),
            status: "running".to_owned(),
            mode: PermissionMode::Ask,
            model: "model".to_owned(),
            effort: None,
            activity: "testing".to_owned(),
            prompt: "test".to_owned(),
            tool: false,
            started_at: 1_000,
            ended_at: None,
            steps: 1,
            tool_calls: 0,
            input_tokens: 2,
            output_tokens: 8,
            generation_ms: 2_000,
            error: None,
        };
        assert!(agent.alive());
        assert_eq!(agent.elapsed_seconds(5_000), 4);
        assert_eq!(agent.tokens_per_second(), 4.);
    }

    #[test]
    fn graph_layout_keeps_rows_and_dependencies() {
        let rows = vec![vec!["a".to_owned()], vec!["b".to_owned()]];
        let edges = vec![PlanGraphEdge {
            from: "a".to_owned(),
            to: "b".to_owned(),
        }];
        let (nodes, width, height) = build_graph(&rows, &edges);
        assert_eq!(nodes.len(), 2);
        assert!(width >= 190.);
        assert!(height >= 216.);
        assert!(nodes.iter().any(|node| node.id == "a" && node.wave == 0));
        assert!(nodes.iter().any(|node| node.id == "b" && node.wave == 1));
    }

    #[test]
    fn timeline_rows_keep_nested_order_and_status() {
        let state = TimelineState {
            status: InspectorStatus::Ready,
            turns: vec![TimelineTurn {
                id: "turn".to_owned(),
                label: "run".to_owned(),
                spans: vec![
                    TimelineSpan {
                        id: "root".to_owned(),
                        parent_id: None,
                        name: "Turn".to_owned(),
                        kind: "agent".to_owned(),
                        started_at: 0,
                        ended_at: Some(100),
                        status: "ok".to_owned(),
                        input: None,
                        output: None,
                        tokens: Some(5),
                    },
                    TimelineSpan {
                        id: "tool".to_owned(),
                        parent_id: Some("root".to_owned()),
                        name: "tool".to_owned(),
                        kind: "tool".to_owned(),
                        started_at: 10,
                        ended_at: Some(50),
                        status: "failed".to_owned(),
                        input: Some("{}".to_owned()),
                        output: None,
                        tokens: Some(2),
                    },
                ],
                live: false,
            }],
            axis: TimelineAxis::Time,
            collapsed: Vec::new(),
            selected: None,
            expanded: false,
            carried_tokens: 7,
            now: 100,
            disabled: false,
        };
        let spans = timeline_spans(&state);
        let rows = timeline_rows(&spans, TimelineAxis::Time, state.now, &[]);
        assert_eq!(rows[0].span.id, "overall");
        assert_eq!(rows[1].span.name, "Turn 1 · run");
        assert_eq!(rows[2].span.status, "failed");
        assert_eq!(rows[2].depth, 1);
    }

    #[test]
    fn git_filter_and_state_match_renderer_contract() {
        assert!(matches_git_filter("*.tsx", "desktop/src/App.tsx"));
        assert!(matches_git_filter("ctx br", "desktop/src/context-bar.tsx"));
        assert!(matches_git_filter(".md", "docs/gpui.md"));
        assert!(!matches_git_filter("rust", "desktop/src/App.tsx"));
        assert_eq!(
            git_file_state(&GitFileSnapshot {
                path: "new.txt".to_owned(),
                index: "A".to_owned(),
                work: "A".to_owned(),
                from: None,
                added: 1,
                removed: 0,
                lines: Vec::new(),
            }),
            "conflict"
        );
    }

    #[test]
    fn inspector_action_contract_keeps_native_mutations_typed() {
        let actions = [
            InspectorAction::SearchMode("a".to_owned()),
            InspectorAction::ToggleContextCurve,
            InspectorAction::ToggleGitBranchMenu,
            InspectorAction::ToggleGitAmend,
            InspectorAction::RemoveCliAttachment("file".to_owned()),
            InspectorAction::OpenModelKeyUrl {
                plan_id: "plan".to_owned(),
                url: "https://example.test".to_owned(),
            },
        ];
        assert_eq!(actions.len(), 6);
    }
}
