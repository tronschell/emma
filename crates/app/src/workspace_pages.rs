use std::rc::Rc;

use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, Div, Entity, InteractiveElement as _, IntoElement as _, ParentElement as _,
    PathBuilder, SharedString, Styled as _, canvas, div, point, px,
};
use gpui_component::{
    Disableable as _, Selectable as _, Sizable as _, StyledExt as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputState, Textarea, TextareaState},
    scroll::ScrollableElement as _,
    v_flex,
};

use crate::navigation::WorkspaceMode;
use crate::theme::EmmaTheme;

pub const PAGE_CONTENT_WIDTH: f32 = 720.;
pub const PAGE_PADDING_TOP: f32 = 16.;
pub const PAGE_PADDING_BOTTOM: f32 = 32.;
pub const FOLDER_CARD_WIDTH: f32 = 156.;
pub const KB_BOARD_COLUMN_WIDTH: f32 = 232.;
pub const ARTIFACT_CARD_MIN_WIDTH: f32 = 280.;
pub const PLUGIN_CARD_MIN_WIDTH: f32 = 260.;
pub const TASK_RAIL_MIN_WIDTH: f32 = 170.;
pub const TASK_RAIL_MAX_WIDTH: f32 = 230.;
pub const TASK_RAIL_ROW_HEIGHT: f32 = 44.;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum PageStatus {
    #[default]
    Loading,
    Ready,
    Empty,
    Error(String),
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum KnowledgeState {
    #[default]
    Loading,
    NoVault,
    Ready,
    Empty,
    Error(String),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum KnowledgeNoteKind {
    Page,
    Screenshot,
    Selection,
    Note,
}

impl KnowledgeNoteKind {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Page => "Page",
            Self::Screenshot => "Screenshot",
            Self::Selection => "Selection",
            Self::Note => "Note",
        }
    }

    pub const fn marker(self) -> &'static str {
        match self {
            Self::Page => "▤",
            Self::Screenshot => "▣",
            Self::Selection => "❝",
            Self::Note => "✎",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KnowledgeFolder {
    pub id: String,
    pub name: String,
    pub saves: usize,
    pub changed_at: String,
    pub hue: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KnowledgeNote {
    pub id: String,
    pub folder: Option<String>,
    pub kind: KnowledgeNoteKind,
    pub title: String,
    pub excerpt: String,
    pub tags: Vec<String>,
    pub saved_at: String,
    pub source: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KnowledgePage {
    pub state: KnowledgeState,
    pub vault: Option<String>,
    pub selected_folder: Option<String>,
    pub folders: Vec<KnowledgeFolder>,
    pub notes: Vec<KnowledgeNote>,
    pub disabled: bool,
}

impl Default for KnowledgePage {
    fn default() -> Self {
        Self {
            state: KnowledgeState::Loading,
            vault: None,
            selected_folder: None,
            folders: Vec::new(),
            notes: Vec::new(),
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactCard {
    pub id: String,
    pub kind: String,
    pub title: String,
    pub version: String,
    pub surface: Option<String>,
    pub preview: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactsPage {
    pub status: PageStatus,
    pub query: String,
    pub kind: Option<String>,
    pub items: Vec<ArtifactCard>,
    pub disabled: bool,
    pub reveal_label: String,
}

impl Default for ArtifactsPage {
    fn default() -> Self {
        Self {
            status: PageStatus::Loading,
            query: String::new(),
            kind: None,
            items: Vec::new(),
            disabled: false,
            reveal_label: "Reveal in Finder".to_string(),
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduledMode {
    Editor,
    Graph,
}

impl ScheduledMode {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Editor => "Editor",
            Self::Graph => "Graph",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledJob {
    pub id: String,
    pub title: String,
    pub trigger: String,
    pub enabled: bool,
    pub next_run: Option<String>,
    pub step_count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledDraft {
    pub id: Option<String>,
    pub title: String,
    pub model: String,
    pub trigger: String,
    pub prompt: String,
    pub runs_as: String,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledStep {
    pub id: String,
    pub kind: String,
    pub text: String,
    pub details: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledRun {
    pub id: String,
    pub at: String,
    pub status: String,
    pub summary: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledVariable {
    pub name: String,
    pub value: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledEditor {
    pub draft: ScheduledDraft,
    pub steps: Vec<ScheduledStep>,
    pub graph_error: Option<String>,
    pub runs: Vec<ScheduledRun>,
    pub variables: Vec<ScheduledVariable>,
    pub dry_run: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledGraph {
    pub title: String,
    pub trigger: String,
    pub steps: Vec<ScheduledStep>,
    pub rows: Vec<Vec<String>>,
    pub edges: Vec<ScheduledGraphEdge>,
    pub selected_step: Option<String>,
    pub stdin: Option<String>,
    pub saves_as: Option<String>,
    pub goes_to: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledGraphEdge {
    pub from: String,
    pub to: String,
    pub label: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GraphBox {
    pub width: f32,
    pub height: f32,
    pub gap_x: f32,
    pub gap_y: f32,
    pub lane: f32,
}

pub const GRAPH_BOX: GraphBox = GraphBox {
    width: 190.,
    height: 76.,
    gap_x: 36.,
    gap_y: 64.,
    lane: 40.,
};

#[derive(Clone, Debug, PartialEq)]
pub struct PlacedGraphNode {
    pub id: String,
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GraphLayout {
    pub placed: Vec<PlacedGraphNode>,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Debug, PartialEq)]
pub struct GraphPath {
    pub d: String,
    pub label_x: f32,
    pub label_y: f32,
}

pub fn place_rows(rows: &[Vec<String>], graph_box: GraphBox) -> GraphLayout {
    let widest = rows.iter().map(Vec::len).max().unwrap_or(1).max(1) as f32;
    let span = widest * graph_box.width + (widest - 1.) * graph_box.gap_x;
    let mut placed = Vec::new();
    for (level, row) in rows.iter().enumerate() {
        let row_span =
            row.len() as f32 * graph_box.width + (row.len() as f32 - 1.) * graph_box.gap_x;
        for (column, id) in row.iter().enumerate() {
            placed.push(PlacedGraphNode {
                id: id.clone(),
                x: graph_box.lane
                    + (span - row_span) / 2.
                    + column as f32 * (graph_box.width + graph_box.gap_x),
                y: level as f32 * (graph_box.height + graph_box.gap_y),
            });
        }
    }
    GraphLayout {
        placed,
        width: span + graph_box.lane * 2.,
        height: if rows.is_empty() {
            graph_box.height
        } else {
            (rows.len() as f32 * (graph_box.height + graph_box.gap_y)) - graph_box.gap_y
        },
    }
}

pub fn edge_path(
    from: &PlacedGraphNode,
    to: &PlacedGraphNode,
    graph_box: GraphBox,
    canvas_width: f32,
) -> GraphPath {
    let x1 = from.x + graph_box.width / 2.;
    let y1 = from.y + graph_box.height;
    let x2 = to.x + graph_box.width / 2.;
    let y2 = to.y - 2.;
    let straight = to.y - from.y == graph_box.height + graph_box.gap_y;
    let lane = if to.y <= from.y {
        graph_box.lane / 2.
    } else {
        canvas_width - graph_box.lane / 2.
    };
    let d = if straight {
        format!(
            "M{x1} {y1} C{x1} {}, {x2} {}, {x2} {y2}",
            y1 + graph_box.gap_y / 2.,
            to.y - graph_box.gap_y / 2.,
        )
    } else {
        format!(
            "M{x1} {y1} C{x1} {}, {lane} {y1}, {lane} {} L{lane} {} C{lane} {y2}, {x2} {}, {x2} {y2}",
            y1 + 24.,
            y1 + 28.,
            y2 - 28.,
            y2 - 28.,
        )
    };
    GraphPath {
        d,
        label_x: if straight { x1 + 8. } else { (x1 + lane) / 2. },
        label_y: y1 + 18.,
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ScheduledPage {
    pub status: PageStatus,
    pub mode: ScheduledMode,
    pub selected: Option<String>,
    pub jobs: Vec<ScheduledJob>,
    pub editor: Option<ScheduledEditor>,
    pub graph: Option<ScheduledGraph>,
    pub disabled: bool,
}

impl Default for ScheduledPage {
    fn default() -> Self {
        Self {
            status: PageStatus::Loading,
            mode: ScheduledMode::Editor,
            selected: None,
            jobs: Vec::new(),
            editor: None,
            graph: None,
            disabled: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum AgentTab {
    Activity,
    Improvement,
    Worktrees,
    Memories,
}

impl AgentTab {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Activity => "Agent activity",
            Self::Improvement => "Self improvement",
            Self::Worktrees => "Worktrees",
            Self::Memories => "Memories",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivitySpan {
    Week,
    Year,
}

impl ActivitySpan {
    pub const fn toggle_label(self) -> &'static str {
        match self {
            Self::Week => "Year",
            Self::Year => "Week",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityDay {
    pub key: String,
    pub count: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityProject {
    pub name: String,
    pub threads: usize,
    pub messages: usize,
    pub last_at: String,
    pub days: Vec<ActivityDay>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ActivityLineage {
    pub id: String,
    pub title: String,
    pub meta: String,
    pub depth: usize,
    pub subagent: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentActivity {
    pub live_threads: usize,
    pub turns: usize,
    pub subagents: usize,
    pub streak: usize,
    pub span: ActivitySpan,
    pub history_open: bool,
    pub days: Vec<ActivityDay>,
    pub started: Vec<ActivityDay>,
    pub projects: Vec<ActivityProject>,
    pub lineage: Vec<ActivityLineage>,
}

impl Default for AgentActivity {
    fn default() -> Self {
        Self {
            live_threads: 0,
            turns: 0,
            subagents: 0,
            streak: 0,
            span: ActivitySpan::Week,
            history_open: false,
            days: Vec::new(),
            started: Vec::new(),
            projects: Vec::new(),
            lineage: Vec::new(),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AgentPage {
    pub status: PageStatus,
    pub tab: AgentTab,
    pub activity: AgentActivity,
    pub disabled: bool,
}

impl Default for AgentPage {
    fn default() -> Self {
        Self {
            status: PageStatus::Loading,
            tab: AgentTab::Activity,
            activity: AgentActivity::default(),
            disabled: false,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum PluginTab {
    Plugins,
    Skills,
    Mcp,
}

impl PluginTab {
    pub const fn label(self) -> &'static str {
        match self {
            Self::Plugins => "Plugins",
            Self::Skills => "Skills",
            Self::Mcp => "MCP servers",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Marketplace {
    pub id: String,
    pub name: String,
    pub origin: String,
    pub reference: String,
    pub sparse: bool,
    pub error: Option<String>,
    pub plugins: Vec<MarketplacePlugin>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MarketplacePlugin {
    pub id: String,
    pub name: String,
    pub description: String,
    pub category: Option<String>,
    pub installed: bool,
    pub version: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstalledPlugin {
    pub id: String,
    pub name: String,
    pub source: String,
    pub version: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CapabilityUsage {
    pub id: String,
    pub name: String,
    pub invocations: usize,
    pub last_used: Option<String>,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PluginsPage {
    pub status: PageStatus,
    pub tab: PluginTab,
    pub query: String,
    pub source: Option<String>,
    pub category: Option<String>,
    pub marketplaces: Vec<Marketplace>,
    pub installed: Vec<InstalledPlugin>,
    pub skills: Vec<CapabilityUsage>,
    pub servers: Vec<CapabilityUsage>,
    pub usage_loading: bool,
    pub disabled: bool,
}

impl Default for PluginsPage {
    fn default() -> Self {
        Self {
            status: PageStatus::Loading,
            tab: PluginTab::Plugins,
            query: String::new(),
            source: None,
            category: None,
            marketplaces: Vec::new(),
            installed: Vec::new(),
            skills: Vec::new(),
            servers: Vec::new(),
            usage_loading: true,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchMetric {
    pub label: String,
    pub value: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchIteration {
    pub id: String,
    pub at: String,
    pub status: String,
    pub metric: Option<String>,
    pub note: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchJob {
    pub id: String,
    pub title: String,
    pub status: String,
    pub since: Option<String>,
    pub optimizing: String,
    pub metric: Option<String>,
    pub best: Option<String>,
    pub attempts: usize,
    pub note: Option<String>,
    pub metrics: Vec<ResearchMetric>,
    pub iterations: Vec<ResearchIteration>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchForm {
    pub title: String,
    pub optimizing: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ResearchPage {
    pub status: PageStatus,
    pub selected: Option<String>,
    pub jobs: Vec<ResearchJob>,
    pub form: Option<ResearchForm>,
    pub disabled: bool,
}

impl Default for ResearchPage {
    fn default() -> Self {
        Self {
            status: PageStatus::Loading,
            selected: None,
            jobs: Vec::new(),
            form: None,
            disabled: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchivedThread {
    pub id: String,
    pub title: String,
    pub archived_at: String,
    pub messages: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArchivePage {
    pub status: PageStatus,
    pub threads: Vec<ArchivedThread>,
    pub disabled: bool,
}

impl Default for ArchivePage {
    fn default() -> Self {
        Self {
            status: PageStatus::Loading,
            threads: Vec::new(),
            disabled: false,
        }
    }
}

#[derive(Clone, Default)]
pub struct ScheduledInputs {
    pub title: Option<Entity<InputState>>,
    pub model: Option<Entity<InputState>>,
    pub trigger: Option<Entity<InputState>>,
    pub prompt: Option<Entity<TextareaState>>,
    pub runs_as: Option<Entity<InputState>>,
}

#[derive(Clone, Default)]
pub struct ResearchInputs {
    pub title: Option<Entity<InputState>>,
    pub optimizing: Option<Entity<TextareaState>>,
}

#[derive(Clone, Default)]
pub struct WorkspacePageInputs {
    pub artifact_query: Option<Entity<InputState>>,
    pub scheduled: ScheduledInputs,
    pub plugins_query: Option<Entity<InputState>>,
    pub research: ResearchInputs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ScheduledField {
    Title,
    Model,
    Trigger,
    Prompt,
    RunsAs,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ResearchField {
    Title,
    Optimizing,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspaceAction {
    ChooseKnowledgeVault,
    ChangeKnowledgeVault,
    OpenKnowledgeFolder(String),
    OpenKnowledgeRoot,
    OpenKnowledgeNote(String),
    CreateKnowledgeFolder,
    MoveKnowledgeNote {
        note_id: String,
        folder_id: String,
    },
    RenameKnowledgeFolder {
        folder_id: String,
        name: String,
    },
    RecolorKnowledgeFolder {
        folder_id: String,
        hue: Option<String>,
    },
    FilterArtifacts(String),
    EditScheduledField {
        field: ScheduledField,
        value: String,
    },
    SelectArtifactKind(Option<String>),
    OpenArtifact(String),
    EditArtifact(String),
    RevealArtifact(String),
    DeleteArtifact(String),
    SelectScheduledJob(String),
    SelectScheduledMode(ScheduledMode),
    NewScheduledTask,
    SaveScheduledTask(ScheduledDraft),
    TestScheduledTask(String),
    RunScheduledTask(String),
    SetScheduledEnabled {
        id: String,
        enabled: bool,
    },
    DeleteScheduledTask(String),
    SelectScheduledStep(String),
    SelectAgentTab(AgentTab),
    ToggleAgentHistory,
    ToggleActivitySpan(ActivitySpan),
    OpenAgentThread(String),
    OpenAgentMemories,
    SelectPluginTab(PluginTab),
    SearchPlugins(String),
    EditResearchField {
        field: ResearchField,
        value: String,
    },
    AddMarketplace,
    SelectMarketplace(String),
    SelectPluginCategory(Option<String>),
    UpdateMarketplace(String),
    RemoveMarketplace(String),
    OpenPlugin(String),
    InstallPlugin(String),
    UninstallPlugin(String),
    ToggleCapability {
        id: String,
        enabled: bool,
    },
    SelectResearch(String),
    NewResearch,
    BackToResearch,
    ToggleResearch(String),
    SaveResearch(ResearchForm),
    DeleteResearch(String),
    RestoreArchivedThread(String),
}

#[derive(Clone)]
pub struct WorkspacePageCallbacks {
    on_action: Rc<dyn Fn(WorkspaceAction)>,
}

impl WorkspacePageCallbacks {
    pub fn new(on_action: impl Fn(WorkspaceAction) + 'static) -> Self {
        Self {
            on_action: Rc::new(on_action),
        }
    }

    pub fn noop() -> Self {
        Self::new(|_| {})
    }

    fn emit(&self, action: WorkspaceAction) {
        (self.on_action)(action);
    }
}

#[allow(clippy::large_enum_variant)]
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum WorkspacePage {
    Knowledge(KnowledgePage),
    Artifacts(ArtifactsPage),
    Scheduled(ScheduledPage),
    Agent(AgentPage),
    Plugins(PluginsPage),
    Research(ResearchPage),
    Archive(ArchivePage),
}

impl WorkspacePage {
    pub const fn mode(&self) -> WorkspaceMode {
        match self {
            Self::Knowledge(_) => WorkspaceMode::Knowledge,
            Self::Artifacts(_) => WorkspaceMode::Artifacts,
            Self::Scheduled(_) => WorkspaceMode::Scheduled,
            Self::Agent(_) => WorkspaceMode::Agent,
            Self::Plugins(_) => WorkspaceMode::Plugins,
            Self::Research(_) => WorkspaceMode::Research,
            Self::Archive(_) => WorkspaceMode::Archive,
        }
    }

    pub fn id(&self) -> &'static str {
        self.mode().id()
    }

    pub fn render(&self, theme: &EmmaTheme, callbacks: WorkspacePageCallbacks) -> Div {
        self.render_with_inputs(theme, callbacks, &WorkspacePageInputs::default())
    }

    pub fn render_with_inputs(
        &self,
        theme: &EmmaTheme,
        callbacks: WorkspacePageCallbacks,
        inputs: &WorkspacePageInputs,
    ) -> Div {
        match self {
            Self::Knowledge(page) => render_knowledge(page, theme, callbacks, inputs),
            Self::Artifacts(page) => render_artifacts(page, theme, callbacks, inputs),
            Self::Scheduled(page) => render_scheduled(page, theme, callbacks, inputs),
            Self::Agent(page) => render_agent(page, theme, callbacks),
            Self::Plugins(page) => render_plugins(page, theme, callbacks, inputs),
            Self::Research(page) => render_research(page, theme, callbacks, inputs),
            Self::Archive(page) => render_archive(page, theme, callbacks),
        }
    }
}

fn page_shell(theme: &EmmaTheme, body: Div) -> Div {
    v_flex()
        .size_full()
        .items_center()
        .bg(theme.colors.bg)
        .text_color(theme.colors.text)
        .child(
            v_flex()
                .size_full()
                .overflow_y_scrollbar()
                .items_center()
                .p_5()
                .pb(theme.spacing.s8)
                .bg(theme.colors.bg)
                .text_color(theme.colors.text)
                .child(
                    v_flex()
                        .w_full()
                        .max_w(theme.dimensions.content_column)
                        .gap_4()
                        .child(body),
                ),
        )
}

fn page_header(
    theme: &EmmaTheme,
    overline: impl Into<SharedString>,
    title: impl Into<SharedString>,
) -> Div {
    v_flex()
        .gap_1()
        .pb_3()
        .border_b_1()
        .border_color(theme.colors.border)
        .child(
            div()
                .text_size(theme.typography.fs_sm)
                .text_color(theme.colors.text_3)
                .child(overline.into()),
        )
        .child(
            div()
                .text_size(theme.typography.fs_3xl)
                .font_bold()
                .child(title.into()),
        )
}

fn panel(theme: &EmmaTheme) -> Div {
    div()
        .border_1()
        .border_color(theme.colors.border)
        .bg(theme.colors.surface)
        .p_4()
}

fn muted(theme: &EmmaTheme, text: impl Into<SharedString>) -> Div {
    div()
        .text_size(theme.typography.fs_sm)
        .text_color(theme.colors.text_2)
        .child(text.into())
}

fn overline(theme: &EmmaTheme, text: impl Into<SharedString>) -> Div {
    div()
        .text_size(theme.typography.fs_xs)
        .text_color(theme.colors.text_3)
        .child(text.into())
}

fn status_panel(
    theme: &EmmaTheme,
    title: impl Into<SharedString>,
    copy: impl Into<SharedString>,
) -> Div {
    panel(theme)
        .child(div().font_bold().child(title.into()))
        .child(muted(theme, copy))
}

fn action_button(
    callbacks: &WorkspacePageCallbacks,
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    action: WorkspaceAction,
    disabled: bool,
    primary: bool,
) -> Button {
    let callbacks = callbacks.clone();
    let button = Button::new(id.into())
        .small()
        .disabled(disabled)
        .label(label.into())
        .on_click(move |_, _, _| callbacks.emit(action.clone()));
    if primary {
        button.primary()
    } else {
        button.ghost()
    }
}

fn tab_button(
    callbacks: &WorkspacePageCallbacks,
    id: impl Into<SharedString>,
    label: impl Into<SharedString>,
    selected: bool,
    action: WorkspaceAction,
    disabled: bool,
) -> Button {
    let callbacks = callbacks.clone();
    Button::new(id.into())
        .small()
        .ghost()
        .selected(selected)
        .disabled(disabled)
        .label(label.into())
        .on_click(move |_, _, _| callbacks.emit(action.clone()))
}

fn list_row(theme: &EmmaTheme, body: Div) -> Div {
    body.border_b_1().border_color(theme.colors.border).py_3()
}

fn state_error(theme: &EmmaTheme, text: &str) -> Div {
    panel(theme)
        .border_color(theme.colors.danger)
        .child(div().text_color(theme.colors.danger).child(text.to_owned()))
}

fn lower_contains(value: &str, query: &str) -> bool {
    value.to_lowercase().contains(&query.trim().to_lowercase())
}

fn artifact_label(kind: &str) -> &str {
    match kind {
        "markdown" => "Document",
        "code" => "Code",
        "html" => "Web page",
        "app" => "App",
        "svg" => "Drawing",
        "mermaid" => "Diagram",
        "react" => "React component",
        other => other,
    }
}

fn render_knowledge(
    page: &KnowledgePage,
    theme: &EmmaTheme,
    callbacks: WorkspacePageCallbacks,
    _inputs: &WorkspacePageInputs,
) -> Div {
    let selected = page.selected_folder.as_deref();
    let selected_folder = selected.and_then(|id| {
        page.folders
            .iter()
            .find(|folder| folder.id == id || folder.name == id)
    });
    let selected_name = selected_folder.map(|folder| folder.name.as_str());
    let shown: Vec<&KnowledgeNote> = page
        .notes
        .iter()
        .filter(|note| match selected_name {
            Some(folder) => {
                note.folder.as_deref() == Some(folder) || note.folder.as_deref() == selected
            }
            None => note.folder.is_none() || note.folder.as_deref() == Some(""),
        })
        .collect();
    let title = selected_name
        .map(str::to_owned)
        .unwrap_or_else(|| format!("{} {}", shown.len(), plural(shown.len(), "save")));
    let heading = if selected.is_some() {
        let callbacks = callbacks.clone();
        Button::new("knowledge-root")
            .ghost()
            .small()
            .disabled(page.disabled)
            .label("← Knowledge base")
            .on_click(move |_, _, _| callbacks.emit(WorkspaceAction::OpenKnowledgeRoot))
    } else {
        Button::new("knowledge-overline")
            .ghost()
            .small()
            .disabled(true)
            .label("Knowledge base")
    };
    let mut header = h_flex().justify_between().items_end().gap_4().child(
        v_flex().gap_1().child(heading).child(
            div()
                .text_size(theme.typography.fs_3xl)
                .font_bold()
                .child(title),
        ),
    );
    if let Some(vault) = page.vault.as_ref() {
        let callbacks = callbacks.clone();
        header = header.child(
            h_flex()
                .gap_2()
                .items_center()
                .child(div().text_size(theme.typography.fs_xs).child(vault.clone()))
                .child(action_button(
                    &callbacks,
                    "knowledge-change-folder",
                    "Change folder…",
                    WorkspaceAction::ChangeKnowledgeVault,
                    page.disabled,
                    false,
                )),
        );
    }
    let mut body = v_flex().gap_4().child(header);
    if let KnowledgeState::Error(error) = &page.state {
        body = body.child(state_error(theme, error));
    }
    match &page.state {
        KnowledgeState::Loading => {
            body = body.child(status_panel(
                theme,
                "Loading…",
                "Reading saved pages and highlights.",
            ));
        }
        KnowledgeState::NoVault => {
            let choose = action_button(
                &callbacks,
                "knowledge-choose-folder",
                "Choose a folder…",
                WorkspaceAction::ChooseKnowledgeVault,
                page.disabled,
                true,
            );
            body = body.child(
                panel(theme)
                    .items_center()
                    .gap_2()
                    .child(div().font_bold().child("No vault yet"))
                    .child(muted(
                        theme,
                        "Pick the Obsidian vault or folder Emma saves into.",
                    ))
                    .child(choose),
            );
        }
        KnowledgeState::Ready | KnowledgeState::Empty | KnowledgeState::Error(_) => {
            if selected.is_none() && page.vault.is_some() {
                let mut shelf = h_flex()
                    .flex_wrap()
                    .gap_4()
                    .border_b_1()
                    .border_color(theme.colors.border)
                    .pb_4();
                for folder in &page.folders {
                    let folder_id = folder.id.clone();
                    let folder_name = folder.name.clone();
                    let callbacks = callbacks.clone();
                    let mut peek = h_flex().gap_1().h(px(28.));
                    for note in page
                        .notes
                        .iter()
                        .filter(|note| note.folder.as_deref() == Some(folder.name.as_str()))
                        .take(4)
                    {
                        peek = peek.child(
                            div()
                                .w(px(20.))
                                .h(px(24.))
                                .items_center()
                                .justify_center()
                                .bg(theme.colors.surface_3)
                                .text_color(theme.colors.accent)
                                .child(note.kind.marker()),
                        );
                    }
                    shelf = shelf.child(
                        v_flex()
                            .w(px(FOLDER_CARD_WIDTH))
                            .min_h(px(98.))
                            .gap_2()
                            .border_1()
                            .border_color(theme.colors.border)
                            .bg(theme.colors.surface)
                            .p_3()
                            .child(peek)
                            .child(action_button(
                                &callbacks,
                                format!("knowledge-folder-{}", folder_id),
                                folder_name,
                                WorkspaceAction::OpenKnowledgeFolder(folder_id),
                                page.disabled,
                                false,
                            ))
                            .child(muted(
                                theme,
                                format!("{} {}", folder.saves, plural(folder.saves, "save")),
                            )),
                    );
                }
                shelf = shelf.child(
                    v_flex()
                        .w(px(FOLDER_CARD_WIDTH))
                        .min_h(px(98.))
                        .gap_2()
                        .border_1()
                        .border_color(theme.colors.border)
                        .bg(theme.colors.surface_2)
                        .p_3()
                        .child(action_button(
                            &callbacks,
                            "knowledge-new-folder",
                            "＋ New folder",
                            WorkspaceAction::CreateKnowledgeFolder,
                            page.disabled,
                            false,
                        ))
                        .child(muted(theme, "Drag saves onto it")),
                );
                body = body.child(shelf);
            }
            if shown.is_empty() {
                let (empty_title, empty_copy) = match selected {
                    Some(_) => (
                        "This folder is empty",
                        "Drag a save onto a folder to file it here.",
                    ),
                    None => (
                        "Nothing saved yet",
                        "Saved pages, screenshots and highlights land in the vault.",
                    ),
                };
                let empty_copy = if selected.is_none() {
                    page.vault.as_ref().map_or_else(
                        || empty_copy.to_string(),
                        |vault| format!("Saved pages, screenshots and highlights land in {vault}."),
                    )
                } else {
                    empty_copy.to_string()
                };
                body = body.child(
                    panel(theme)
                        .items_center()
                        .gap_2()
                        .child(div().font_bold().child(empty_title))
                        .child(muted(theme, empty_copy)),
                );
            } else {
                let mut board = h_flex().flex_wrap().gap_4();
                for note in shown {
                    let note_id = note.id.clone();
                    let mut tags = h_flex().flex_wrap().gap_1();
                    for tag in &note.tags {
                        tags = tags.child(
                            div()
                                .px_2()
                                .py_1()
                                .bg(theme.colors.surface_3)
                                .text_size(theme.typography.fs_xs)
                                .child(tag.clone()),
                        );
                    }
                    let mut card = v_flex()
                        .w(px(KB_BOARD_COLUMN_WIDTH))
                        .gap_2()
                        .border_1()
                        .border_color(theme.colors.border)
                        .bg(theme.colors.surface)
                        .p_3()
                        .child(
                            h_flex()
                                .gap_2()
                                .child(
                                    div()
                                        .text_color(theme.colors.accent)
                                        .child(note.kind.marker()),
                                )
                                .child(overline(theme, note.kind.label())),
                        )
                        .child(div().font_bold().child(note.title.clone()));
                    if !note.excerpt.is_empty() {
                        card = card.child(muted(theme, note.excerpt.clone()));
                    }
                    if !note.tags.is_empty() {
                        card = card.child(tags);
                    }
                    let mut footer = h_flex()
                        .justify_between()
                        .gap_2()
                        .child(overline(theme, note.saved_at.clone()));
                    if let Some(source) = note.source.as_ref() {
                        footer = footer.child(overline(theme, source.clone()));
                    }
                    card = card.child(footer).child(action_button(
                        &callbacks,
                        format!("knowledge-open-{}", note_id),
                        "Open in Obsidian ↗",
                        WorkspaceAction::OpenKnowledgeNote(note_id),
                        page.disabled,
                        false,
                    ));
                    board = board.child(card);
                }
                body = body.child(board);
            }
        }
    }
    page_shell(theme, body)
}

fn plural(count: usize, singular: &str) -> String {
    if count == 1 {
        singular.to_string()
    } else {
        format!("{singular}s")
    }
}

fn render_artifacts(
    page: &ArtifactsPage,
    theme: &EmmaTheme,
    callbacks: WorkspacePageCallbacks,
    inputs: &WorkspacePageInputs,
) -> Div {
    let mut body = v_flex()
        .gap_4()
        .child(page_header(theme, "Workspace", "Artifacts"));
    match &page.status {
        PageStatus::Loading => {
            body = body.child(status_panel(
                theme,
                "Loading…",
                "Reading the artifacts folder.",
            ));
        }
        PageStatus::Error(_) => {
            body = body.child(state_error(
                theme,
                "Emma could not read the artifacts folder.",
            ));
        }
        PageStatus::Ready | PageStatus::Empty => {
            if page.items.is_empty() {
                body = body.child(
                    panel(theme)
                        .items_center()
                        .gap_2()
                        .child(div().font_bold().child("Nothing kept yet"))
                        .child(muted(
                            theme,
                            "An artifact is something a conversation produced that is worth keeping — a document, a snippet, a page, a drawing, a diagram. Type /artifact in a thread to make one.",
                        )),
                );
            } else {
                let mut kinds = Vec::new();
                for item in &page.items {
                    if !kinds.iter().any(|kind: &String| kind == &item.kind) {
                        kinds.push(item.kind.clone());
                    }
                }
                let mut toolbar = h_flex()
                    .gap_2()
                    .flex_wrap()
                    .child(scheduled_field_with_inputs(
                        theme,
                        "Filter by title",
                        &page.query,
                        "Filter by title",
                        inputs.artifact_query.as_ref(),
                        None,
                        page.disabled,
                    ))
                    .child(tab_button(
                        &callbacks,
                        "artifacts-kind-all",
                        "All",
                        page.kind.is_none(),
                        WorkspaceAction::SelectArtifactKind(None),
                        page.disabled,
                    ));
                for kind in kinds {
                    toolbar = toolbar.child(tab_button(
                        &callbacks,
                        format!("artifacts-kind-{kind}"),
                        artifact_label(&kind),
                        page.kind.as_deref() == Some(kind.as_str()),
                        WorkspaceAction::SelectArtifactKind(Some(kind.clone())),
                        page.disabled,
                    ));
                }
                body = body.child(toolbar);
                let shown: Vec<&ArtifactCard> = page
                    .items
                    .iter()
                    .filter(|item| {
                        (page.kind.is_none() || page.kind.as_deref() == Some(item.kind.as_str()))
                            && (page.query.trim().is_empty()
                                || lower_contains(&item.title, &page.query))
                    })
                    .collect();
                if shown.is_empty() {
                    body = body.child(status_panel(
                        theme,
                        "Nothing matches that.",
                        "Try another title or kind.",
                    ));
                } else {
                    let mut grid = h_flex().flex_wrap().gap_4();
                    for item in shown {
                        let mut card = v_flex()
                            .min_w(px(ARTIFACT_CARD_MIN_WIDTH))
                            .flex_1()
                            .gap_2()
                            .border_1()
                            .border_color(theme.colors.border)
                            .bg(theme.colors.surface)
                            .p_4()
                            .child(overline(theme, artifact_label(&item.kind)))
                            .child(div().font_bold().child(item.title.clone()))
                            .child(overline(theme, format!("Version {}", item.version)));
                        if let Some(surface) = item.surface.as_ref() {
                            card = card.child(overline(theme, surface.clone()));
                        }
                        if let Some(preview) = item.preview.as_ref() {
                            card = card.child(
                                div()
                                    .h(px(190.))
                                    .overflow_y_scrollbar()
                                    .p_3()
                                    .bg(theme.colors.surface_2)
                                    .text_size(theme.typography.fs_sm)
                                    .child(preview.clone()),
                            );
                        }
                        let id = item.id.clone();
                        let mut actions = h_flex().gap_2().flex_wrap();
                        actions = actions
                            .child(action_button(
                                &callbacks,
                                format!("artifact-edit-{id}"),
                                "Edit in a thread",
                                WorkspaceAction::EditArtifact(id.clone()),
                                page.disabled,
                                false,
                            ))
                            .child(action_button(
                                &callbacks,
                                format!("artifact-reveal-{id}"),
                                page.reveal_label.clone(),
                                WorkspaceAction::RevealArtifact(id.clone()),
                                page.disabled,
                                false,
                            ))
                            .child(action_button(
                                &callbacks,
                                format!("artifact-delete-{id}"),
                                "Delete",
                                WorkspaceAction::DeleteArtifact(id.clone()),
                                page.disabled,
                                false,
                            ));
                        card = card.child(action_button(
                            &callbacks,
                            format!("artifact-open-{id}"),
                            "Open",
                            WorkspaceAction::OpenArtifact(id),
                            page.disabled,
                            true,
                        ));
                        grid = grid.child(card.child(actions));
                    }
                    body = body.child(grid);
                }
            }
        }
    }
    page_shell(theme, body)
}

fn blank_scheduled_draft() -> ScheduledDraft {
    ScheduledDraft {
        id: None,
        title: String::new(),
        model: String::new(),
        trigger: "0 9 * * 1".to_string(),
        prompt: String::new(),
        runs_as: String::new(),
        enabled: true,
    }
}

fn scheduled_draft_valid(draft: &ScheduledDraft) -> bool {
    !draft.title.trim().is_empty()
        && !draft.model.trim().is_empty()
        && !draft.trigger.trim().is_empty()
        && !draft.prompt.trim().is_empty()
        && !draft.runs_as.trim().is_empty()
}

fn scheduled_field_with_inputs(
    theme: &EmmaTheme,
    name: &'static str,
    value: &str,
    placeholder: &'static str,
    input: Option<&Entity<InputState>>,
    textarea: Option<&Entity<TextareaState>>,
    disabled: bool,
) -> AnyElement {
    let shown = if value.is_empty() { placeholder } else { value };
    let control = if let Some(state) = input {
        Input::new(state)
            .aria_label(name)
            .h(px(32.))
            .appearance(true)
            .bordered(true)
            .focus_bordered(true)
            .disabled(disabled)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_sm)
            .text_color(theme.colors.text)
            .into_any_element()
    } else if let Some(state) = textarea {
        Textarea::new(state)
            .aria_label(name)
            .h(px(96.))
            .appearance(true)
            .bordered(true)
            .disabled(disabled)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_sm)
            .text_color(theme.colors.text)
            .into_any_element()
    } else {
        div()
            .min_h(px(32.))
            .border_1()
            .border_color(theme.colors.border_strong)
            .bg(theme.colors.surface_2)
            .px_3()
            .py_2()
            .text_size(theme.typography.fs_sm)
            .text_color(if value.is_empty() {
                theme.colors.text_3
            } else {
                theme.colors.text
            })
            .child(shown.to_owned())
            .into_any_element()
    };
    v_flex()
        .gap_1()
        .child(overline(theme, name))
        .child(control)
        .into_any_element()
}

fn render_scheduled(
    page: &ScheduledPage,
    theme: &EmmaTheme,
    callbacks: WorkspacePageCallbacks,
    inputs: &WorkspacePageInputs,
) -> Div {
    let mut body = v_flex()
        .gap_4()
        .child(page_header(theme, "Workspace", "Workflows"))
        .child(
            h_flex()
                .gap_1()
                .child(tab_button(
                    &callbacks,
                    "scheduled-editor-tab",
                    "Editor",
                    page.mode == ScheduledMode::Editor,
                    WorkspaceAction::SelectScheduledMode(ScheduledMode::Editor),
                    page.disabled,
                ))
                .child(tab_button(
                    &callbacks,
                    "scheduled-graph-tab",
                    "Graph",
                    page.mode == ScheduledMode::Graph,
                    WorkspaceAction::SelectScheduledMode(ScheduledMode::Graph),
                    page.disabled,
                )),
        );
    if matches!(&page.status, PageStatus::Loading) {
        body = body.child(status_panel(theme, "Loading…", "Reading scheduled tasks."));
    }
    if matches!(&page.status, PageStatus::Error(_)) {
        body = body.child(state_error(theme, "Emma could not read scheduled tasks."));
    }
    let mut rail = v_flex()
        .w(px(TASK_RAIL_MAX_WIDTH))
        .min_w(px(TASK_RAIL_MIN_WIDTH))
        .flex_none()
        .gap_2()
        .border_1()
        .border_color(theme.colors.border)
        .bg(theme.colors.surface_2)
        .p_3()
        .child(overline(theme, "Scheduled tasks"));
    for job in &page.jobs {
        let id = job.id.clone();
        let callbacks = callbacks.clone();
        let state = if job.enabled { "live" } else { "paused" };
        rail = rail.child(
            v_flex()
                .min_h(px(TASK_RAIL_ROW_HEIGHT))
                .gap_1()
                .child(action_button(
                    &callbacks,
                    format!("scheduled-job-{}", id),
                    job.title.clone(),
                    WorkspaceAction::SelectScheduledJob(id),
                    page.disabled,
                    page.selected.as_deref() == Some(job.id.as_str()),
                ))
                .child(muted(
                    theme,
                    format!("{} · {} · {}", job.trigger, state, job.step_count),
                )),
        );
    }
    rail = rail.child(action_button(
        &callbacks,
        "scheduled-new-task",
        "+ New task",
        WorkspaceAction::NewScheduledTask,
        page.disabled,
        true,
    ));
    let detail = match page.mode {
        ScheduledMode::Editor => render_scheduled_editor(page, theme, &callbacks, inputs),
        ScheduledMode::Graph => render_scheduled_graph(page, theme, &callbacks),
    };
    body = body.child(h_flex().items_start().gap_4().child(rail).child(detail));
    page_shell(theme, body)
}

fn render_scheduled_editor(
    page: &ScheduledPage,
    theme: &EmmaTheme,
    callbacks: &WorkspacePageCallbacks,
    inputs: &WorkspacePageInputs,
) -> Div {
    let Some(editor) = page.editor.as_ref() else {
        let draft = blank_scheduled_draft();
        return v_flex()
            .flex_1()
            .min_w_0()
            .gap_4()
            .child(panel(theme).child(div().font_bold().child("New task")))
            .child(
                panel(theme)
                    .gap_3()
                    .child(scheduled_field_with_inputs(
                        theme,
                        "Title",
                        &draft.title,
                        "Weekly reading sweep",
                        inputs.scheduled.title.as_ref(),
                        None,
                        page.disabled,
                    ))
                    .child(scheduled_field_with_inputs(
                        theme,
                        "Model",
                        &draft.model,
                        "Choose a model",
                        inputs.scheduled.model.as_ref(),
                        None,
                        page.disabled,
                    ))
                    .child(scheduled_field_with_inputs(
                        theme,
                        "Trigger",
                        &draft.trigger,
                        "0 9 * * 1",
                        inputs.scheduled.trigger.as_ref(),
                        None,
                        page.disabled,
                    ))
                    .child(scheduled_field_with_inputs(
                        theme,
                        "What it does",
                        &draft.prompt,
                        "What should Emma do on each run?",
                        None,
                        inputs.scheduled.prompt.as_ref(),
                        page.disabled,
                    ))
                    .child(scheduled_field_with_inputs(
                        theme,
                        "Runs as",
                        &draft.runs_as,
                        "Choose a permission mode",
                        inputs.scheduled.runs_as.as_ref(),
                        None,
                        page.disabled,
                    ))
                    .child(action_button(
                        callbacks,
                        "scheduled-create-task",
                        "Create task",
                        WorkspaceAction::SaveScheduledTask(draft.clone()),
                        page.disabled || !scheduled_draft_valid(&draft),
                        true,
                    )),
            );
    };
    let draft = &editor.draft;
    let draft_title = if draft.title.is_empty() {
        "New task".to_owned()
    } else {
        draft.title.clone()
    };
    let task_id = draft.id.clone().unwrap_or_else(|| "new".to_string());
    let mut content = v_flex()
        .flex_1()
        .min_w_0()
        .gap_4()
        .child(
            panel(theme)
                .gap_2()
                .child(
                    h_flex()
                        .justify_between()
                        .child(
                            v_flex()
                                .gap_1()
                                .child(div().font_bold().child(draft_title.clone()))
                                .child(muted(
                                    theme,
                                    if draft.id.is_none() {
                                        "Not saved yet"
                                    } else if draft.enabled {
                                        "Waits for its trigger"
                                    } else {
                                        "Paused"
                                    },
                                )),
                        )
                        .child(if let Some(next) = page
                            .jobs
                            .iter()
                            .find(|job| job.id == task_id)
                            .and_then(|job| job.next_run.as_ref())
                        {
                            muted(theme, format!("Next run {next}"))
                        } else {
                            muted(theme, "")
                        }),
                )
                .child(
                    v_flex()
                        .gap_3()
                        .child(scheduled_field_with_inputs(
                            theme,
                            "Title",
                            &draft.title,
                            "Weekly reading sweep",
                            inputs.scheduled.title.as_ref(),
                            None,
                            page.disabled,
                        ))
                        .child(scheduled_field_with_inputs(
                            theme,
                            "Model",
                            &draft.model,
                            "Choose a model",
                            inputs.scheduled.model.as_ref(),
                            None,
                            page.disabled,
                        ))
                        .child(scheduled_field_with_inputs(
                            theme,
                            "Trigger",
                            &draft.trigger,
                            "When should it run?",
                            inputs.scheduled.trigger.as_ref(),
                            None,
                            page.disabled,
                        ))
                        .child(scheduled_field_with_inputs(
                            theme,
                            "What it does",
                            &draft.prompt,
                            "What should Emma do on each run? Type / for a skill or tool, @ for a file, artifact or saved page",
                            None,
                            inputs.scheduled.prompt.as_ref(),
                            page.disabled,
                        ))
                        .child(scheduled_field_with_inputs(
                            theme,
                            "Runs as",
                            &draft.runs_as,
                            "Choose a permission mode",
                            inputs.scheduled.runs_as.as_ref(),
                            None,
                            page.disabled,
                        )),
                ),
        );
    let mut steps = v_flex().gap_2().child(
        h_flex()
            .justify_between()
            .child(div().font_bold().child("Steps"))
            .child(muted(
                theme,
                format!(
                    "{} {}",
                    editor.steps.len(),
                    plural(editor.steps.len(), "step")
                ),
            )),
    );
    if let Some(error) = editor.graph_error.as_ref() {
        steps = steps.child(state_error(theme, error));
    }
    if editor.steps.is_empty() {
        steps = steps.child(muted(theme, "No steps yet."));
    } else {
        for step in &editor.steps {
            let step_id = step.id.clone();
            let detail = step.details.clone().unwrap_or_default();
            steps = steps.child(action_button(
                callbacks,
                format!("scheduled-step-{}", step_id),
                format!("{} · {} · {}", step.kind, step.text, detail),
                WorkspaceAction::SelectScheduledStep(step_id),
                page.disabled,
                false,
            ));
        }
    }
    content = content.child(panel(theme).child(steps));
    let save_label = if draft.id.is_some() {
        "Save"
    } else {
        "Create task"
    };
    let mut actions = h_flex()
        .gap_2()
        .flex_wrap()
        .child(action_button(
            callbacks,
            "scheduled-save",
            save_label,
            WorkspaceAction::SaveScheduledTask(draft.clone()),
            page.disabled || !scheduled_draft_valid(draft),
            true,
        ))
        .child(action_button(
            callbacks,
            "scheduled-test",
            "Test",
            WorkspaceAction::TestScheduledTask(task_id.clone()),
            page.disabled || draft.id.is_none(),
            false,
        ))
        .child(action_button(
            callbacks,
            "scheduled-run-now",
            "Run now",
            WorkspaceAction::RunScheduledTask(task_id.clone()),
            page.disabled || draft.id.is_none(),
            false,
        ))
        .child(action_button(
            callbacks,
            "scheduled-pause",
            if draft.enabled { "Pause" } else { "Resume" },
            WorkspaceAction::SetScheduledEnabled {
                id: task_id.clone(),
                enabled: !draft.enabled,
            },
            page.disabled || draft.id.is_none(),
            false,
        ));
    if draft.id.is_some() {
        actions = actions.child(action_button(
            callbacks,
            "scheduled-delete",
            "Delete for good",
            WorkspaceAction::DeleteScheduledTask(task_id),
            page.disabled,
            false,
        ));
    }
    content = content.child(actions);
    if editor.dry_run {
        content = content.child(muted(theme, "Dry run"));
    }
    content = content.child(
        panel(theme)
            .gap_2()
            .child(div().font_bold().child("Write the graph"))
            .child(muted(
                theme,
                "Each node has an id, a kind and text. agent runs its text as a turn, script runs a fixed absolute file from a connected folder with optional templated input on stdin, set stores its text, and if branches. saveAs keeps output as a variable; use it later with {{name}}, while {{last}} is the last agent answer. A step with no next falls through; next: end finishes the run. Leave this empty for a task that is just its prompt.",
            )),
    );
    let mut runs = panel(theme).gap_2().child(div().font_bold().child("Runs"));
    if editor.runs.is_empty() {
        runs = runs.child(muted(theme, "Nothing has run yet."));
    } else {
        for run in &editor.runs {
            runs = runs.child(list_row(
                theme,
                h_flex()
                    .justify_between()
                    .child(div().child(run.at.clone()))
                    .child(muted(
                        theme,
                        format!(
                            "{} · {}",
                            run.status,
                            run.summary.clone().unwrap_or_default()
                        ),
                    )),
            ));
        }
    }
    content = content.child(runs);
    if !editor.variables.is_empty() {
        let mut variables = panel(theme)
            .gap_2()
            .child(div().font_bold().child("Variables"));
        for variable in &editor.variables {
            variables = variables.child(list_row(
                theme,
                h_flex()
                    .justify_between()
                    .child(div().child(variable.name.clone()))
                    .child(muted(theme, variable.value.clone())),
            ));
        }
        content = content.child(variables);
    }
    content
}

fn render_scheduled_graph(
    page: &ScheduledPage,
    theme: &EmmaTheme,
    callbacks: &WorkspacePageCallbacks,
) -> Div {
    let Some(graph) = page.graph.as_ref() else {
        return v_flex()
            .flex_1()
            .min_w_0()
            .items_center()
            .justify_center()
            .child(muted(theme, "Pick a task on the left to see its graph."));
    };
    let mut body = v_flex().flex_1().min_w_0().gap_4().child(
        panel(theme)
            .child(div().font_bold().child(graph.title.clone()))
            .child(muted(
                theme,
                format!(
                    "{} · {} {}",
                    graph.trigger,
                    graph.steps.len(),
                    plural(graph.steps.len(), "step")
                ),
            )),
    );
    let mut rows = if graph.rows.is_empty() {
        graph
            .steps
            .iter()
            .map(|step| vec![step.id.clone()])
            .collect::<Vec<_>>()
    } else {
        graph.rows.clone()
    };
    let mut edges = if graph.edges.is_empty() {
        graph
            .steps
            .iter()
            .enumerate()
            .map(|(index, step)| ScheduledGraphEdge {
                from: step.id.clone(),
                to: graph
                    .steps
                    .get(index + 1)
                    .map_or_else(|| "end".to_owned(), |next| next.id.clone()),
                label: None,
            })
            .collect::<Vec<_>>()
    } else {
        graph.edges.clone()
    };
    let has_end = edges.iter().any(|edge| edge.to == "end") || graph.steps.is_empty();
    if has_end && !rows.iter().any(|row| row.iter().any(|id| id == "end")) {
        rows.push(vec!["end".to_owned()]);
    }
    if graph.steps.is_empty() {
        body = body.child(panel(theme).child(muted(
            theme,
            "This task has no steps yet. Write a prompt, or a node graph, and it draws itself here.",
        )));
    } else {
        let layout = place_rows(&rows, GRAPH_BOX);
        let positions = layout
            .placed
            .iter()
            .map(|placed| (placed.id.clone(), placed.clone()))
            .collect::<std::collections::HashMap<_, _>>();
        edges.retain(|edge| positions.contains_key(&edge.from) && positions.contains_key(&edge.to));
        let mut graph_canvas = div()
            .relative()
            .w(px(layout.width))
            .h(px(layout.height))
            .child(render_graph_edges(&edges, &positions, layout.width, theme));
        for edge in &edges {
            let Some(from) = positions.get(&edge.from) else {
                continue;
            };
            let Some(to) = positions.get(&edge.to) else {
                continue;
            };
            if let Some(label) = edge.label.as_ref() {
                let path = edge_path(from, to, GRAPH_BOX, layout.width);
                graph_canvas = graph_canvas.child(
                    div()
                        .absolute()
                        .left(px(path.label_x))
                        .top(px(path.label_y))
                        .text_size(theme.typography.fs_xs)
                        .text_color(theme.colors.text_3)
                        .child(label.clone()),
                );
            }
        }
        for placed in &layout.placed {
            if placed.id == "end" {
                graph_canvas = graph_canvas.child(
                    div()
                        .absolute()
                        .left(px(placed.x))
                        .top(px(placed.y))
                        .w(px(GRAPH_BOX.width))
                        .h(px(GRAPH_BOX.height))
                        .items_center()
                        .justify_center()
                        .border_1()
                        .border_color(theme.colors.border)
                        .bg(theme.colors.surface_2)
                        .text_color(theme.colors.text_3)
                        .text_size(theme.typography.fs_sm)
                        .child("◼ end of run"),
                );
                continue;
            }
            let Some(step) = graph.steps.iter().find(|step| step.id == placed.id) else {
                continue;
            };
            let selected = graph.selected_step.as_deref() == Some(step.id.as_str());
            let step_id = step.id.clone();
            let callbacks = callbacks.clone();
            let node = Button::new(format!("scheduled-graph-step-{}", step_id))
                .small()
                .ghost()
                .selected(selected)
                .disabled(page.disabled)
                .accessibility_label(format!("{} {}", step.kind, step.id))
                .child(
                    v_flex()
                        .gap_1()
                        .items_start()
                        .child(overline(
                            theme,
                            format!("{} {}", graph_kind_glyph(&step.kind), step.kind),
                        ))
                        .child(div().font_bold().child(step.id.clone()))
                        .child(muted(theme, step.text.clone()))
                        .when_some(step.details.clone(), |this, details| {
                            this.child(overline(theme, details))
                        }),
                )
                .on_click(move |_, _, _| {
                    callbacks.emit(WorkspaceAction::SelectScheduledStep(step_id.clone()))
                });
            graph_canvas = graph_canvas.child(
                div()
                    .absolute()
                    .left(px(placed.x))
                    .top(px(placed.y))
                    .w(px(GRAPH_BOX.width))
                    .h(px(GRAPH_BOX.height))
                    .child(node.w_full().h_full()),
            );
        }
        body = body.child(
            panel(theme).child(
                div()
                    .overflow_x_scrollbar()
                    .child(div().overflow_y_scrollbar().child(graph_canvas)),
            ),
        );
    }
    if let Some(step) = graph
        .selected_step
        .as_ref()
        .and_then(|id| graph.steps.iter().find(|step| &step.id == id))
    {
        let mut detail = panel(theme)
            .gap_2()
            .child(overline(theme, "Step"))
            .child(div().font_bold().child(step.text.clone()))
            .child(overline(theme, format!("Condition · {}", step.kind)));
        if let Some(value) = step.details.as_ref() {
            detail = detail.child(overline(theme, format!("Value · {value}")));
        }
        if let Some(stdin) = graph.stdin.as_ref() {
            detail = detail.child(overline(theme, format!("Stdin · {stdin}")));
        }
        if let Some(saves_as) = graph.saves_as.as_ref() {
            detail = detail.child(overline(theme, format!("Saves as · {saves_as}")));
        }
        if let Some(goes_to) = graph.goes_to.as_ref() {
            detail = detail.child(overline(theme, format!("Goes to · {goes_to}")));
        }
        body = body.child(detail);
    }
    body.child(
        h_flex()
            .gap_2()
            .child(action_button(
                callbacks,
                "scheduled-graph-run-now",
                "Run now",
                WorkspaceAction::RunScheduledTask(page.selected.clone().unwrap_or_default()),
                page.disabled || page.selected.is_none(),
                true,
            ))
            .child(action_button(
                callbacks,
                "scheduled-graph-pause",
                "Pause",
                WorkspaceAction::SetScheduledEnabled {
                    id: page.selected.clone().unwrap_or_default(),
                    enabled: false,
                },
                page.disabled || page.selected.is_none(),
                false,
            )),
    )
}

fn graph_kind_glyph(kind: &str) -> &'static str {
    match kind {
        "agent" => "◆",
        "script" => "▶",
        "set" => "◇",
        "if" => "◈",
        _ => "◇",
    }
}

fn render_graph_edges(
    edges: &[ScheduledGraphEdge],
    positions: &std::collections::HashMap<String, PlacedGraphNode>,
    canvas_width: f32,
    theme: &EmmaTheme,
) -> AnyElement {
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
                let x1 = from.x + GRAPH_BOX.width / 2.;
                let y1 = from.y + GRAPH_BOX.height;
                let x2 = to.x + GRAPH_BOX.width / 2.;
                let y2 = to.y - 2.;
                let straight = to.y - from.y == GRAPH_BOX.height + GRAPH_BOX.gap_y;
                let lane = if to.y <= from.y {
                    GRAPH_BOX.lane / 2.
                } else {
                    canvas_width - GRAPH_BOX.lane / 2.
                };
                let origin = bounds.origin;
                let at = |x: f32, y: f32| point(origin.x + px(x), origin.y + px(y));
                let mut builder = PathBuilder::stroke(px(1.));
                builder.move_to(at(x1, y1));
                if straight {
                    builder.cubic_bezier_to(
                        at(x2, y2),
                        at(x1, y1 + GRAPH_BOX.gap_y / 2.),
                        at(x2, to.y - GRAPH_BOX.gap_y / 2.),
                    );
                } else {
                    builder.cubic_bezier_to(at(lane, y1 + 28.), at(x1, y1 + 24.), at(lane, y1));
                    builder.line_to(at(lane, y2 - 28.));
                    builder.cubic_bezier_to(at(x2, y2), at(lane, y2), at(x2, y2 - 28.));
                }
                if let Ok(path) = builder.build() {
                    window.paint_path(path, color);
                }
            }
        },
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

fn activity_cell_color(theme: &EmmaTheme, count: usize, peak: usize) -> gpui::Hsla {
    if count == 0 {
        theme.colors.surface_3
    } else if peak <= 1 || count * 4 >= peak * 3 {
        theme.colors.lime
    } else if count * 2 >= peak {
        theme.colors.teal
    } else {
        theme.colors.accent_soft
    }
}

fn render_activity(
    activity: &AgentActivity,
    theme: &EmmaTheme,
    callbacks: &WorkspacePageCallbacks,
    disabled: bool,
) -> Div {
    let mut metrics = h_flex().flex_wrap().gap_2();
    for (value, label) in [
        (activity.live_threads, "live thread"),
        (activity.turns, "turn asked"),
        (activity.subagents, "subagent spawned"),
        (activity.streak, "day streak"),
    ] {
        metrics = metrics.child(
            panel(theme)
                .flex_1()
                .min_w(px(150.))
                .child(
                    div()
                        .text_size(theme.typography.fs_2xl)
                        .font_bold()
                        .child(value.to_string()),
                )
                .child(muted(theme, format!("{} {}", value, plural(value, label)))),
        );
    }
    let total = activity.days.iter().map(|day| day.count).sum::<usize>();
    let active = activity.days.iter().filter(|day| day.count > 0).count();
    let peak = activity.days.iter().map(|day| day.count).max().unwrap_or(1);
    let mut heat = h_flex().flex_wrap().gap_1();
    for day in &activity.days {
        heat = heat.child(
            div()
                .id(format!("activity-day-{}", day.key))
                .w(px(10.))
                .h(px(10.))
                .bg(activity_cell_color(theme, day.count, peak)),
        );
    }
    let mut heat_panel = panel(theme)
        .gap_3()
        .child(
            h_flex()
                .justify_between()
                .child(
                    v_flex()
                        .gap_1()
                        .child(div().font_bold().child("Every day"))
                        .child(muted(
                            theme,
                            format!(
                                "{} {} · {} active {} · {} day streak",
                                total,
                                plural(total, "message"),
                                active,
                                plural(active, "day"),
                                activity.streak
                            ),
                        )),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .child(action_button(
                            callbacks,
                            "activity-span",
                            activity.span.toggle_label(),
                            WorkspaceAction::ToggleActivitySpan(activity.span),
                            disabled,
                            false,
                        ))
                        .child(action_button(
                            callbacks,
                            "activity-history",
                            "All time",
                            WorkspaceAction::ToggleAgentHistory,
                            disabled,
                            false,
                        )),
                ),
        )
        .child(heat)
        .child(
            h_flex()
                .justify_between()
                .child(overline(theme, "Less"))
                .child(
                    h_flex()
                        .gap_1()
                        .child(div().w(px(10.)).h(px(10.)).bg(theme.colors.surface_3))
                        .child(div().w(px(10.)).h(px(10.)).bg(theme.colors.accent_soft))
                        .child(div().w(px(10.)).h(px(10.)).bg(theme.colors.teal))
                        .child(div().w(px(10.)).h(px(10.)).bg(theme.colors.lime)),
                )
                .child(overline(theme, "More")),
        );
    if activity.history_open {
        let mut history = panel(theme)
            .gap_2()
            .child(overline(theme, "Every day Emma has run"))
            .child(div().font_bold().child("All time"));
        for day in &activity.days {
            history = history.child(list_row(
                theme,
                h_flex()
                    .justify_between()
                    .child(div().child(day.key.clone()))
                    .child(muted(theme, format!("{} messages", day.count))),
            ));
        }
        heat_panel = heat_panel.child(history);
    }
    let mut started = panel(theme).gap_3().child(
        h_flex()
            .justify_between()
            .child(div().font_bold().child("Threads started"))
            .child(muted(
                theme,
                format!(
                    "Peak {}/day",
                    activity
                        .started
                        .iter()
                        .map(|day| day.count)
                        .max()
                        .unwrap_or(0)
                ),
            )),
    );
    if activity.started.is_empty() {
        started = started.child(muted(theme, "No threads yet."));
    } else {
        for day in &activity.started {
            started = started.child(
                h_flex()
                    .gap_2()
                    .child(overline(theme, day.key.clone()))
                    .child(
                        div()
                            .h(px(10.))
                            .w(px((day.count.max(1) * 18) as f32))
                            .bg(theme.colors.accent),
                    )
                    .child(muted(theme, day.count.to_string())),
            );
        }
    }
    let mut projects = panel(theme).gap_3().child(
        h_flex()
            .justify_between()
            .child(div().font_bold().child("Projects over time"))
            .child(muted(
                theme,
                format!("{} projects", activity.projects.len()),
            )),
    );
    if activity.projects.is_empty() {
        projects = projects.child(muted(theme, "No threads yet."));
    } else {
        for project in &activity.projects {
            projects = projects.child(list_row(
                theme,
                v_flex()
                    .gap_1()
                    .child(
                        h_flex()
                            .justify_between()
                            .child(div().font_bold().child(project.name.clone()))
                            .child(muted(theme, format!("{} messages", project.messages))),
                    )
                    .child(muted(
                        theme,
                        format!(
                            "{} {} · last {}",
                            project.threads,
                            plural(project.threads, "thread"),
                            project.last_at
                        ),
                    )),
            ));
        }
    }
    let mut lineage = panel(theme).gap_3().child(
        h_flex()
            .justify_between()
            .child(div().font_bold().child("Thread tree"))
            .child(muted(
                theme,
                format!("{} of {}", activity.lineage.len(), activity.lineage.len()),
            )),
    );
    if activity.lineage.is_empty() {
        lineage = lineage.child(muted(theme, "No threads yet"));
    } else {
        for row in &activity.lineage {
            let id = row.id.clone();
            let callbacks = callbacks.clone();
            lineage = lineage.child(
                h_flex()
                    .gap_2()
                    .pl(px((row.depth * 14) as f32))
                    .child(action_button(
                        &callbacks,
                        format!("activity-thread-{}", id),
                        if row.subagent {
                            format!("{} · subagent", row.title)
                        } else {
                            row.title.clone()
                        },
                        WorkspaceAction::OpenAgentThread(id),
                        disabled,
                        false,
                    ))
                    .child(muted(theme, row.meta.clone())),
            );
        }
    }
    v_flex()
        .gap_4()
        .child(metrics)
        .child(heat_panel)
        .child(started)
        .child(projects)
        .child(lineage)
}

fn render_agent(page: &AgentPage, theme: &EmmaTheme, callbacks: WorkspacePageCallbacks) -> Div {
    let title = match page.tab {
        AgentTab::Activity | AgentTab::Memories => "Agent activity",
        AgentTab::Improvement => "What keeps going wrong",
        AgentTab::Worktrees => "Worktrees",
    };
    let mut tabs = h_flex()
        .gap_1()
        .child(tab_button(
            &callbacks,
            "agent-activity-tab",
            "Agent activity",
            page.tab == AgentTab::Activity,
            WorkspaceAction::SelectAgentTab(AgentTab::Activity),
            page.disabled,
        ))
        .child(tab_button(
            &callbacks,
            "agent-improvement-tab",
            "Self improvement",
            page.tab == AgentTab::Improvement,
            WorkspaceAction::SelectAgentTab(AgentTab::Improvement),
            page.disabled,
        ))
        .child(tab_button(
            &callbacks,
            "agent-worktrees-tab",
            "Worktrees",
            page.tab == AgentTab::Worktrees,
            WorkspaceAction::SelectAgentTab(AgentTab::Worktrees),
            page.disabled,
        ));
    tabs = tabs.child(action_button(
        &callbacks,
        "agent-memories",
        "Memories",
        WorkspaceAction::OpenAgentMemories,
        page.disabled,
        false,
    ));
    let mut body = v_flex()
        .gap_4()
        .child(page_header(theme, "Agent", title))
        .child(tabs);
    if let PageStatus::Error(error) = &page.status {
        body = body.child(state_error(theme, error));
    }
    match page.tab {
        AgentTab::Activity | AgentTab::Memories => {
            if matches!(&page.status, PageStatus::Loading) {
                body = body.child(muted(theme, "Reading traces…"));
            }
            body = body.child(render_activity(
                &page.activity,
                theme,
                &callbacks,
                page.disabled,
            ));
        }
        AgentTab::Improvement => {
            body = body
                .child(
                    h_flex()
                        .flex_wrap()
                        .gap_2()
                        .child(panel(theme).child(div().font_bold().child("0 turns read")))
                        .child(panel(theme).child(div().font_bold().child("0% ended badly")))
                        .child(panel(theme).child(div().font_bold().child("0 repeating patterns")))
                        .child(panel(theme).child(div().font_bold().child("0 lessons kept"))),
                )
                .child(status_panel(
                    theme,
                    "No finished turns yet.",
                    "Nothing repeated twice.",
                ));
        }
        AgentTab::Worktrees => {
            body = body.child(status_panel(
                theme,
                "No worktrees here yet — only the main checkout.",
                "Connect a folder from the ＋ menu to see its worktrees.",
            ));
        }
    }
    page_shell(theme, body)
}

struct UsageRender<'a> {
    rows: &'a [CapabilityUsage],
    label: &'a str,
    empty_title: &'a str,
    empty_copy: &'a str,
    loading: bool,
    theme: &'a EmmaTheme,
    callbacks: &'a WorkspacePageCallbacks,
    disabled: bool,
}

fn render_usage(spec: UsageRender<'_>) -> Div {
    let UsageRender {
        rows,
        label,
        empty_title,
        empty_copy,
        loading,
        theme,
        callbacks,
        disabled,
    } = spec;
    if loading && rows.is_empty() {
        return v_flex()
            .gap_4()
            .child(status_panel(theme, "Counting invocations…", ""));
    }
    if rows.is_empty() {
        return v_flex()
            .gap_4()
            .child(status_panel(theme, empty_title, empty_copy));
    }
    let invocations = rows.iter().map(|row| row.invocations).sum::<usize>();
    let off = rows.iter().filter(|row| !row.enabled).count();
    let mut metrics = h_flex().flex_wrap().gap_2();
    for (value, title) in [
        (invocations, "Invocations".to_string()),
        (invocations, "Last 30 days".to_string()),
        (rows.len(), label.to_string()),
        (off, "Off".to_string()),
    ] {
        metrics = metrics.child(
            panel(theme)
                .flex_1()
                .min_w(px(140.))
                .child(
                    div()
                        .text_size(theme.typography.fs_2xl)
                        .font_bold()
                        .child(value.to_string()),
                )
                .child(muted(theme, title)),
        );
    }
    let mut over_time = panel(theme)
        .gap_2()
        .child(div().font_bold().child("Over time"));
    let peak = rows.iter().map(|row| row.invocations).max().unwrap_or(1);
    for row in rows {
        over_time = over_time.child(
            h_flex()
                .gap_2()
                .child(overline(theme, row.name.clone()))
                .child(
                    div()
                        .h(px(10.))
                        .w(px((row.invocations.max(1) * 120 / peak.max(1)) as f32))
                        .bg(theme.colors.accent),
                )
                .child(muted(theme, row.invocations.to_string())),
        );
    }
    let mut most_used = panel(theme)
        .gap_2()
        .child(div().font_bold().child("Most used"));
    let mut sorted = rows.to_vec();
    sorted.sort_by_key(|row| std::cmp::Reverse(row.invocations));
    for row in sorted.iter().take(5) {
        most_used = most_used.child(list_row(
            theme,
            h_flex()
                .justify_between()
                .child(div().child(row.name.clone()))
                .child(muted(theme, format!("{} invocations", row.invocations))),
        ));
    }
    let mut every = panel(theme).gap_2().child(
        div()
            .font_bold()
            .child(format!("Every {label}").to_string()),
    );
    for row in rows {
        let id = row.id.clone();
        every = every.child(list_row(
            theme,
            h_flex()
                .justify_between()
                .child(
                    v_flex()
                        .gap_1()
                        .child(div().child(row.name.clone()))
                        .child(muted(
                            theme,
                            row.last_used
                                .clone()
                                .unwrap_or_else(|| "Not used yet".to_string()),
                        )),
                )
                .child(action_button(
                    callbacks,
                    format!("capability-toggle-{}", id),
                    if row.enabled { "Off" } else { "On" },
                    WorkspaceAction::ToggleCapability {
                        id,
                        enabled: !row.enabled,
                    },
                    disabled,
                    false,
                )),
        ));
    }
    v_flex()
        .gap_4()
        .child(metrics)
        .child(over_time)
        .child(most_used)
        .child(every)
}

fn render_plugins(
    page: &PluginsPage,
    theme: &EmmaTheme,
    callbacks: WorkspacePageCallbacks,
    inputs: &WorkspacePageInputs,
) -> Div {
    let mut body = v_flex()
        .gap_4()
        .child(page_header(
            theme,
            "",
            match page.tab {
                PluginTab::Plugins => "Plugins",
                PluginTab::Skills => "Skills",
                PluginTab::Mcp => "MCP servers",
            },
        ))
        .child(
            h_flex()
                .gap_1()
                .child(tab_button(
                    &callbacks,
                    "plugins-tab",
                    "Plugins",
                    page.tab == PluginTab::Plugins,
                    WorkspaceAction::SelectPluginTab(PluginTab::Plugins),
                    page.disabled,
                ))
                .child(tab_button(
                    &callbacks,
                    "skills-tab",
                    "Skills",
                    page.tab == PluginTab::Skills,
                    WorkspaceAction::SelectPluginTab(PluginTab::Skills),
                    page.disabled,
                ))
                .child(tab_button(
                    &callbacks,
                    "mcp-tab",
                    "MCP servers",
                    page.tab == PluginTab::Mcp,
                    WorkspaceAction::SelectPluginTab(PluginTab::Mcp),
                    page.disabled,
                )),
        );
    if let PageStatus::Error(error) = &page.status {
        body = body.child(state_error(theme, error));
    }
    match page.tab {
        PluginTab::Skills => {
            body = body.child(render_usage(UsageRender {
                rows: &page.skills,
                label: "skills",
                empty_title: "No skills yet",
                empty_copy:
                    "Install a plugin, or run /import to find the ones already on this computer.",
                loading: page.usage_loading,
                theme,
                callbacks: &callbacks,
                disabled: page.disabled,
            }));
        }
        PluginTab::Mcp => {
            body = body.child(render_usage(UsageRender {
                rows: &page.servers,
                label: "servers",
                empty_title: "No MCP servers yet",
                empty_copy:
                    "Install a plugin that carries one, or run /import to find the servers other agents already keep here.",
                loading: page.usage_loading,
                theme,
                callbacks: &callbacks,
                disabled: page.disabled,
            }));
        }
        PluginTab::Plugins => {
            let mut toolbar = h_flex()
                .gap_2()
                .flex_wrap()
                .child(scheduled_field_with_inputs(
                    theme,
                    "Search plugins",
                    &page.query,
                    "Search plugins",
                    inputs.plugins_query.as_ref(),
                    None,
                    page.disabled,
                ))
                .child(action_button(
                    &callbacks,
                    "plugins-add-marketplace",
                    "Add marketplace",
                    WorkspaceAction::AddMarketplace,
                    page.disabled,
                    true,
                ));
            let mut sources = Vec::new();
            let mut categories = Vec::new();
            for marketplace in &page.marketplaces {
                if !sources
                    .iter()
                    .any(|source: &String| source == &marketplace.name)
                {
                    sources.push(marketplace.name.clone());
                }
                for plugin in &marketplace.plugins {
                    if let Some(category) = plugin.category.as_ref()
                        && !categories.iter().any(|known: &String| known == category)
                    {
                        categories.push(category.clone());
                    }
                }
            }
            toolbar = toolbar.child(tab_button(
                &callbacks,
                "plugins-source-all",
                "All sources",
                page.source.is_none(),
                WorkspaceAction::SelectMarketplace(String::new()),
                page.disabled,
            ));
            for source in sources {
                toolbar = toolbar.child(tab_button(
                    &callbacks,
                    format!("plugins-source-{source}"),
                    source.clone(),
                    page.source.as_deref() == Some(source.as_str()),
                    WorkspaceAction::SelectMarketplace(source),
                    page.disabled,
                ));
            }
            toolbar = toolbar.child(tab_button(
                &callbacks,
                "plugins-category-all",
                "All",
                page.category.is_none(),
                WorkspaceAction::SelectPluginCategory(None),
                page.disabled,
            ));
            for category in categories {
                toolbar = toolbar.child(tab_button(
                    &callbacks,
                    format!("plugins-category-{category}"),
                    category.clone(),
                    page.category.as_deref() == Some(category.as_str()),
                    WorkspaceAction::SelectPluginCategory(Some(category)),
                    page.disabled,
                ));
            }
            body = body.child(toolbar);
            if matches!(&page.status, PageStatus::Loading) && page.marketplaces.is_empty() {
                body = body.child(status_panel(
                    theme,
                    "Fetching the official Codex marketplace…",
                    "",
                ));
            } else if page.marketplaces.is_empty() {
                body = body.child(
                    panel(theme)
                        .items_center()
                        .gap_2()
                        .child(div().font_bold().child("No marketplaces yet"))
                        .child(muted(
                            theme,
                            "A marketplace is a catalog of plugins: a GitHub repo, a Git URL, or a folder on this computer. Emma files the ones she writes here too.",
                        ))
                        .child(action_button(
                            &callbacks,
                            "plugins-add-marketplace-empty",
                            "Add plugin marketplace",
                            WorkspaceAction::AddMarketplace,
                            page.disabled,
                            true,
                        )),
                );
            } else {
                for marketplace in &page.marketplaces {
                    if page.source.as_deref().is_some_and(|source| {
                        source != marketplace.id && source != marketplace.name
                    }) {
                        continue;
                    }
                    let mut source_panel = panel(theme).gap_3().child(
                        h_flex()
                            .justify_between()
                            .child(
                                v_flex()
                                    .gap_1()
                                    .child(div().font_bold().child(marketplace.name.clone()))
                                    .child(overline(
                                        theme,
                                        format!(
                                            "{} · {}{}",
                                            marketplace.origin,
                                            marketplace.reference,
                                            if marketplace.sparse { " · sparse" } else { "" }
                                        ),
                                    )),
                            )
                            .child(
                                h_flex()
                                    .gap_1()
                                    .child(action_button(
                                        &callbacks,
                                        format!("marketplace-update-{}", marketplace.id),
                                        "Update",
                                        WorkspaceAction::UpdateMarketplace(marketplace.id.clone()),
                                        page.disabled,
                                        false,
                                    ))
                                    .child(action_button(
                                        &callbacks,
                                        format!("marketplace-remove-{}", marketplace.id),
                                        "Remove",
                                        WorkspaceAction::RemoveMarketplace(marketplace.id.clone()),
                                        page.disabled,
                                        false,
                                    )),
                            ),
                    );
                    if let Some(error) = marketplace.error.as_ref() {
                        source_panel = source_panel.child(state_error(theme, error));
                    }
                    let shown: Vec<&MarketplacePlugin> = marketplace
                        .plugins
                        .iter()
                        .filter(|plugin| {
                            (page.category.is_none()
                                || page.category.as_deref() == plugin.category.as_deref())
                                && (page.query.trim().is_empty()
                                    || lower_contains(&plugin.name, &page.query)
                                    || lower_contains(&plugin.description, &page.query))
                        })
                        .collect();
                    if shown.is_empty() {
                        source_panel =
                            source_panel.child(muted(theme, "This marketplace lists no plugins."));
                    } else {
                        let mut grid = h_flex().flex_wrap().gap_3();
                        for plugin in shown {
                            let id = plugin.id.clone();
                            let mut card = v_flex()
                                .min_w(px(PLUGIN_CARD_MIN_WIDTH))
                                .flex_1()
                                .gap_2()
                                .border_1()
                                .border_color(theme.colors.border)
                                .bg(theme.colors.surface_2)
                                .p_3()
                                .child(div().font_bold().child(plugin.name.clone()))
                                .child(muted(theme, plugin.description.clone()));
                            if let Some(category) = plugin.category.as_ref() {
                                card = card.child(overline(theme, category.clone()));
                            }
                            if let Some(version) = plugin.version.as_ref() {
                                card = card.child(overline(theme, format!("Version {version}")));
                            }
                            card = card.child(action_button(
                                &callbacks,
                                format!("plugin-open-{id}"),
                                if plugin.installed {
                                    "Installed"
                                } else {
                                    "Install"
                                },
                                if plugin.installed {
                                    WorkspaceAction::OpenPlugin(id)
                                } else {
                                    WorkspaceAction::InstallPlugin(id)
                                },
                                page.disabled,
                                !plugin.installed,
                            ));
                            grid = grid.child(card);
                        }
                        source_panel = source_panel.child(grid);
                    }
                    body = body.child(source_panel);
                }
            }
            if !page.installed.is_empty() {
                let mut installed = panel(theme).gap_2().child(
                    h_flex()
                        .justify_between()
                        .child(div().font_bold().child("Installed"))
                        .child(muted(theme, page.installed.len().to_string())),
                );
                for plugin in &page.installed {
                    installed = installed.child(list_row(
                        theme,
                        h_flex()
                            .justify_between()
                            .child(
                                v_flex()
                                    .gap_1()
                                    .child(div().child(plugin.name.clone()))
                                    .child(overline(
                                        theme,
                                        format!(
                                            "{}{}",
                                            plugin.source,
                                            plugin
                                                .version
                                                .as_ref()
                                                .map_or(String::new(), |version| format!(
                                                    " · {version}"
                                                ))
                                        ),
                                    )),
                            )
                            .child(action_button(
                                &callbacks,
                                format!("plugin-uninstall-{}", plugin.id),
                                "Remove",
                                WorkspaceAction::UninstallPlugin(plugin.id.clone()),
                                page.disabled,
                                false,
                            )),
                    ));
                }
                body = body.child(installed);
            }
        }
    }
    page_shell(theme, body)
}

fn render_research_form(
    page: &ResearchPage,
    form: &ResearchForm,
    theme: &EmmaTheme,
    callbacks: &WorkspacePageCallbacks,
    inputs: &WorkspacePageInputs,
) -> Div {
    let mut body = v_flex()
        .gap_4()
        .child(action_button(
            callbacks,
            "research-back",
            "← All experiments",
            WorkspaceAction::BackToResearch,
            page.disabled,
            false,
        ))
        .child(overline(theme, "Autoresearch · new experiment"))
        .child(div().text_size(theme.typography.fs_3xl).font_bold().child("What are you optimising?"))
        .child(muted(
            theme,
            "Emma proposes one change at a time, runs your eval command, reads the metric, and keeps the change only when the number improved. Everything below can be edited later except the metric and the folder.",
        ));
    body = body.child(
        panel(theme)
            .gap_3()
            .child(scheduled_field_with_inputs(
                theme,
                "Title",
                &form.title,
                "Morning research sweep",
                inputs.research.title.as_ref(),
                None,
                page.disabled,
            ))
            .child(scheduled_field_with_inputs(
                theme,
                "What are you optimising?",
                &form.optimizing,
                "Describe the result you want to improve",
                None,
                inputs.research.optimizing.as_ref(),
                page.disabled,
            ))
            .child(action_button(
                callbacks,
                "research-create",
                "Create experiment",
                WorkspaceAction::SaveResearch(form.clone()),
                page.disabled,
                true,
            )),
    );
    body
}

fn render_research_detail(
    page: &ResearchPage,
    job: &ResearchJob,
    theme: &EmmaTheme,
    callbacks: &WorkspacePageCallbacks,
) -> Div {
    let mut body = v_flex()
        .gap_4()
        .child(action_button(
            callbacks,
            "research-detail-back",
            "← All experiments",
            WorkspaceAction::BackToResearch,
            page.disabled,
            false,
        ))
        .child(
            h_flex()
                .justify_between()
                .child(
                    v_flex()
                        .gap_1()
                        .child(overline(
                            theme,
                            format!("{} · {} attempts", job.status, job.attempts),
                        ))
                        .child(
                            div()
                                .text_size(theme.typography.fs_3xl)
                                .font_bold()
                                .child(job.title.clone()),
                        )
                        .child(muted(
                            theme,
                            job.since.as_ref().map_or_else(
                                || "Not started yet".to_string(),
                                |since| format!("Since {since}"),
                            ),
                        )),
                )
                .child(
                    h_flex()
                        .gap_1()
                        .child(action_button(
                            callbacks,
                            "research-detail-toggle",
                            if job.status == "running" {
                                "Pause"
                            } else {
                                "Start"
                            },
                            WorkspaceAction::ToggleResearch(job.id.clone()),
                            page.disabled,
                            true,
                        ))
                        .child(action_button(
                            callbacks,
                            "research-detail-delete",
                            "Delete",
                            WorkspaceAction::DeleteResearch(job.id.clone()),
                            page.disabled,
                            false,
                        )),
                ),
        )
        .child(muted(theme, format!("Optimising · {}", job.optimizing)));
    let mut graph = panel(theme)
        .gap_2()
        .child(div().font_bold().child("Experiment over time"));
    if job.iterations.is_empty() {
        graph = graph.child(muted(theme, "Nothing has run yet."));
    } else {
        let peak = job
            .iterations
            .iter()
            .filter_map(|iteration| iteration.metric.as_deref()?.parse::<usize>().ok())
            .max()
            .unwrap_or(1);
        for iteration in &job.iterations {
            let metric = iteration.metric.clone().unwrap_or_else(|| "—".to_string());
            let width = metric.parse::<usize>().unwrap_or(0).max(1) * 140 / peak.max(1);
            graph = graph.child(
                h_flex()
                    .gap_2()
                    .child(overline(theme, iteration.at.clone()))
                    .child(div().h(px(10.)).w(px(width as f32)).bg(theme.colors.accent))
                    .child(muted(theme, metric)),
            );
        }
    }
    body = body.child(graph);
    if !job.metrics.is_empty() {
        let mut metrics = h_flex().flex_wrap().gap_2();
        for metric in &job.metrics {
            metrics = metrics.child(
                panel(theme)
                    .flex_1()
                    .min_w(px(140.))
                    .child(overline(theme, metric.label.clone()))
                    .child(div().font_bold().child(metric.value.clone())),
            );
        }
        body = body.child(metrics);
    } else {
        body = body.child(
            h_flex()
                .flex_wrap()
                .gap_2()
                .child(panel(theme).child(overline(theme, "Metric")))
                .child(panel(theme).child(overline(theme, "Best")))
                .child(panel(theme).child(overline(theme, "Attempts"))),
        );
    }
    let mut log = panel(theme)
        .gap_2()
        .child(div().font_bold().child("Run log"));
    if job.iterations.is_empty() {
        log = log.child(muted(theme, "Nothing has run yet."));
    } else {
        for iteration in &job.iterations {
            log = log.child(list_row(
                theme,
                h_flex()
                    .justify_between()
                    .child(
                        v_flex()
                            .gap_1()
                            .child(div().child(iteration.at.clone()))
                            .child(muted(theme, iteration.note.clone().unwrap_or_default())),
                    )
                    .child(muted(
                        theme,
                        format!(
                            "{} · {}",
                            iteration.status,
                            iteration.metric.clone().unwrap_or_else(|| "—".to_string())
                        ),
                    )),
            ));
        }
    }
    body.child(log)
}

fn render_research(
    page: &ResearchPage,
    theme: &EmmaTheme,
    callbacks: WorkspacePageCallbacks,
    inputs: &WorkspacePageInputs,
) -> Div {
    if let Some(form) = page.form.as_ref() {
        return page_shell(
            theme,
            render_research_form(page, form, theme, &callbacks, inputs),
        );
    }
    if let Some(job) = page
        .selected
        .as_ref()
        .and_then(|id| page.jobs.iter().find(|job| &job.id == id))
    {
        return page_shell(theme, render_research_detail(page, job, theme, &callbacks));
    }
    let mut body = v_flex().gap_4().child(
        h_flex()
            .justify_between()
            .items_end()
            .child(page_header(theme, "Workspace", "Experiments"))
            .child(action_button(
                &callbacks,
                "research-new",
                "+ New experiment",
                WorkspaceAction::NewResearch,
                page.disabled,
                true,
            )),
    );
    if matches!(&page.status, PageStatus::Loading) {
        body = body.child(status_panel(theme, "Loading…", "Reading experiments."));
    }
    if matches!(&page.status, PageStatus::Error(_)) {
        body = body.child(state_error(
            theme,
            "Emma could not read autoresearch experiments.",
        ));
    }
    if matches!(&page.status, PageStatus::Ready | PageStatus::Empty) && page.jobs.is_empty() {
        body = body.child(
            panel(theme)
                .items_center()
                .gap_2()
                .child(div().font_bold().child("No experiments yet"))
                .child(muted(
                    theme,
                    "Create one here, or ask Emma to set one up on a folder you have already granted.",
                )),
        );
    } else {
        for job in &page.jobs {
            let id = job.id.clone();
            body = body.child(
                panel(theme)
                    .gap_2()
                    .child(
                        h_flex()
                            .justify_between()
                            .child(action_button(
                                &callbacks,
                                format!("research-select-{id}"),
                                job.title.clone(),
                                WorkspaceAction::SelectResearch(id.clone()),
                                page.disabled,
                                page.selected.as_deref() == Some(id.as_str()),
                            ))
                            .child(overline(theme, job.status.clone())),
                    )
                    .child(muted(theme, format!("Optimising · {}", job.optimizing)))
                    .child(
                        h_flex()
                            .flex_wrap()
                            .gap_3()
                            .child(overline(
                                theme,
                                format!(
                                    "Metric · {}",
                                    job.metric.clone().unwrap_or_else(|| "—".to_string())
                                ),
                            ))
                            .child(overline(
                                theme,
                                format!(
                                    "Best · {}",
                                    job.best.clone().unwrap_or_else(|| "—".to_string())
                                ),
                            ))
                            .child(overline(theme, format!("Attempts · {}", job.attempts))),
                    )
                    .child(action_button(
                        &callbacks,
                        format!("research-toggle-{id}"),
                        if job.status == "running" {
                            "Pause"
                        } else {
                            "Start"
                        },
                        WorkspaceAction::ToggleResearch(id),
                        page.disabled,
                        false,
                    )),
            );
        }
    }
    page_shell(theme, body)
}

fn render_archive(page: &ArchivePage, theme: &EmmaTheme, callbacks: WorkspacePageCallbacks) -> Div {
    let mut body = v_flex()
        .gap_4()
        .child(page_header(theme, "Archive · auto-discard", "Archived threads"))
        .child(muted(
            theme,
            "Right-click any thread in the sidebar to archive it. Archived threads are deleted permanently 30 days after they are archived.",
        ));
    match &page.status {
        PageStatus::Loading => {
            body = body.child(status_panel(theme, "Loading…", "Reading archived threads."));
        }
        PageStatus::Error(_) => {
            body = body.child(state_error(theme, "Emma could not read archived threads."));
        }
        PageStatus::Ready | PageStatus::Empty => {
            if page.threads.is_empty() {
                body = body.child(
                    panel(theme)
                        .items_center()
                        .gap_2()
                        .child(div().font_bold().child("Nothing archived"))
                        .child(muted(
                            theme,
                            "Archived threads appear here until they are discarded.",
                        )),
                );
            } else {
                for thread in &page.threads {
                    body = body.child(
                        panel(theme)
                            .gap_2()
                            .child(
                                h_flex()
                                    .justify_between()
                                    .child(
                                        v_flex()
                                            .gap_1()
                                            .child(overline(theme, "Archived"))
                                            .child(div().font_bold().child(thread.title.clone())),
                                    )
                                    .child(action_button(
                                        &callbacks,
                                        format!("archive-restore-{}", thread.id),
                                        "Restore",
                                        WorkspaceAction::RestoreArchivedThread(thread.id.clone()),
                                        page.disabled,
                                        true,
                                    )),
                            )
                            .child(
                                h_flex()
                                    .gap_3()
                                    .child(muted(theme, format!("Archived {}", thread.archived_at)))
                                    .child(muted(
                                        theme,
                                        format!(
                                            "{} {}",
                                            thread.messages,
                                            plural(thread.messages, "message")
                                        ),
                                    )),
                            ),
                    );
                }
            }
        }
    }
    page_shell(theme, body)
}

#[cfg(test)]
mod tests {
    use std::cell::RefCell;
    use std::rc::Rc;

    use super::*;

    #[test]
    fn workspace_pages_keep_navigation_identity() {
        let pages = [
            WorkspacePage::Knowledge(KnowledgePage::default()),
            WorkspacePage::Artifacts(ArtifactsPage::default()),
            WorkspacePage::Scheduled(ScheduledPage::default()),
            WorkspacePage::Agent(AgentPage::default()),
            WorkspacePage::Plugins(PluginsPage::default()),
            WorkspacePage::Research(ResearchPage::default()),
            WorkspacePage::Archive(ArchivePage::default()),
        ];
        let ids = pages.iter().map(WorkspacePage::id).collect::<Vec<_>>();
        assert_eq!(
            ids,
            vec![
                "knowledge",
                "artifacts",
                "scheduled",
                "agent",
                "plugins",
                "research",
                "archive"
            ]
        );
        assert_eq!(pages[0].mode(), WorkspaceMode::Knowledge);
        assert_eq!(pages[6].mode(), WorkspaceMode::Archive);
    }

    #[test]
    fn note_markers_and_pluralization_match_renderer() {
        assert_eq!(KnowledgeNoteKind::Page.marker(), "▤");
        assert_eq!(KnowledgeNoteKind::Screenshot.marker(), "▣");
        assert_eq!(KnowledgeNoteKind::Selection.marker(), "❝");
        assert_eq!(KnowledgeNoteKind::Note.marker(), "✎");
        assert_eq!(plural(1, "save"), "save");
        assert_eq!(plural(0, "save"), "saves");
        assert!(lower_contains("Weekly Reading Sweep", "reading"));
        assert!(!lower_contains("Weekly Reading Sweep", "archive"));
    }

    #[test]
    fn callback_boundary_emits_typed_actions() {
        let received = Rc::new(RefCell::new(Vec::new()));
        let sink = received.clone();
        let callbacks = WorkspacePageCallbacks::new(move |action| sink.borrow_mut().push(action));
        callbacks.emit(WorkspaceAction::AddMarketplace);
        callbacks.emit(WorkspaceAction::RestoreArchivedThread(
            "thread-1".to_string(),
        ));
        assert_eq!(
            *received.borrow(),
            vec![
                WorkspaceAction::AddMarketplace,
                WorkspaceAction::RestoreArchivedThread("thread-1".to_string())
            ]
        );
    }

    #[test]
    fn defaults_cover_each_baseline_state() {
        assert_eq!(KnowledgePage::default().state, KnowledgeState::Loading);
        assert_eq!(ArtifactsPage::default().status, PageStatus::Loading);
        assert_eq!(ScheduledPage::default().mode, ScheduledMode::Editor);
        assert_eq!(AgentPage::default().tab, AgentTab::Activity);
        assert_eq!(PluginsPage::default().tab, PluginTab::Plugins);
        assert_eq!(ResearchPage::default().form, None);
        assert_eq!(ArchivePage::default().threads.len(), 0);
    }

    #[test]
    fn graph_layout_matches_renderer_geometry() {
        let rows = vec![
            vec!["start".to_owned()],
            vec!["left".to_owned(), "right".to_owned()],
        ];
        let layout = place_rows(&rows, GRAPH_BOX);
        assert_eq!(layout.width, 496.);
        assert_eq!(layout.height, 216.);
        assert_eq!(layout.placed[0].x, 153.);
        assert_eq!(layout.placed[1].x, 40.);
        assert_eq!(layout.placed[2].x, 266.);
        let path = edge_path(
            &layout.placed[0],
            &layout.placed[1],
            GRAPH_BOX,
            layout.width,
        );
        assert_eq!(path.label_x, 256.);
        assert_eq!(path.label_y, 94.);
        assert!(path.d.starts_with("M248 76 C248 108"));
    }

    #[test]
    fn scheduled_draft_save_requires_editable_values() {
        let blank = blank_scheduled_draft();
        assert!(!scheduled_draft_valid(&blank));
        let complete = ScheduledDraft {
            id: None,
            title: "Sweep".to_owned(),
            model: "model".to_owned(),
            trigger: "0 9 * * 1".to_owned(),
            prompt: "Read".to_owned(),
            runs_as: "Ask".to_owned(),
            enabled: true,
        };
        assert!(scheduled_draft_valid(&complete));
    }
}
