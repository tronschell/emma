use std::collections::{BTreeMap, HashSet};

use serde_json::Value;

use crate::conversation::{
    ComposerSubmission, ConversationBlock, ConversationEntry, ConversationLoadState,
    ConversationMessage, ConversationRole, ConversationRun, EditDiff, GenerationMeta,
    NestedAgentStatus, PermissionMode, RunState, ThinkingBlock, split_thinking, thought_tokens,
};
use crate::inspector_surfaces::{
    ActivityDaySnapshot, ActivityLineageSnapshot, ActivityProjectSnapshot, ActivitySpan,
    ActivitySurfaceState, AgentPanelState, AgentRailState, AgentSnapshot, AgentTabSnapshot,
    BackgroundRailState, ChangeLine, ChangesPanelState, CliAttachment, CliRunState,
    ContextAgentRow, ContextCurvePoint, ContextLedgerRow, ContextMetricSnapshot,
    ContextSettingsState, ContextState, ContextThreadRow, ContextWidgetSnapshot,
    FileChangeSnapshot, GitPageState, GitPanelState, GitReadyState, GoalAgentSnapshot,
    GoalPlanStep, GoalRevisionSnapshot, GoalSurfaceState, HarnessFlow, HarnessHealth,
    HarnessSurfaceState, InspectorAction, InspectorStatus, InspectorSurface, MachineSurfaceState,
    MachineView, ModePickerState, ModelPlanSnapshot, ModelPlansState, PermissionPromptState,
    PermissionRequest, PlanGraphEdge, PlanGraphNode, PlanRailState, PlanSnapshot, PlanStepSnapshot,
    SubagentChip, SubagentChipsState, TabStripState, TaskListSnapshot, TaskListState, TaskSnapshot,
    ThreadCardState, TimelineAxis, TimelineSpan, TimelineState, TimelineTurn, TranscriptItem,
};
use crate::runtime_services::{
    HostCommand, HostMessage, HostThreadSummary, RuntimeAgentUpdate, RuntimeCommand,
    RuntimeContext, RuntimePlan, RuntimeService, RuntimeState, RuntimeTask, RuntimeTaskList,
    RuntimeThread, RuntimeTimelineSpan, RuntimeUsage,
};
use crate::workspace_pages::{GRAPH_BOX, GraphBox, place_rows};

pub const CONTEXT_CHARS_PER_TOKEN: usize = 4;
pub const MAX_CONTEXT_METRICS: usize = 21;
pub const MAX_CONTEXT_ROWS: usize = 32;
pub const MAX_CONTEXT_PAGES: usize = 4;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextPageSource {
    pub id: String,
    pub name: String,
    pub widgets: Vec<ContextWidgetSnapshot>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InspectorRuntimeInput {
    pub now: u64,
    pub selected_context_page: Option<String>,
    pub context_pages: Vec<ContextPageSource>,
    pub context_capacity_tokens: Option<usize>,
    pub context_metrics: Vec<String>,
    pub context_curve: Vec<ContextCurvePoint>,
    pub context_experiments: Option<String>,
    pub context_curve_open: bool,
    pub context_ledger_expanded: bool,
    pub context_show_all: bool,
    pub context_agents_open: bool,
    pub context_settings: Option<ContextSettingsState>,
    pub background: Option<BackgroundRailState>,
    pub changes: Option<ChangesPanelState>,
    pub machine: Option<MachineSurfaceState>,
    pub git: Option<GitPageState>,
    pub cli: Vec<CliRunState>,
    pub harness: Option<HarnessSurfaceState>,
    pub goal: Option<GoalSurfaceState>,
    pub activity: Option<ActivitySurfaceState>,
    pub model_plans: Option<ModelPlansState>,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct InspectorRuntimeProjection {
    pub selected_thread_id: Option<String>,
    pub mode: ModePickerState,
    pub permission: PermissionPromptState,
    pub agent_rail: AgentRailState,
    pub background: BackgroundRailState,
    pub tabs: TabStripState,
    pub agent_panel: AgentPanelState,
    pub thread_card: ThreadCardState,
    pub subagent_chips: SubagentChipsState,
    pub changes: ChangesPanelState,
    pub context: ContextState,
    pub context_settings: ContextSettingsState,
    pub plan: PlanRailState,
    pub tasks: TaskListState,
    pub timeline: TimelineState,
    pub machine: MachineSurfaceState,
    pub git: GitPanelState,
    pub git_page: GitPageState,
    pub cli: Vec<CliRunState>,
    pub harness: HarnessSurfaceState,
    pub goal: GoalSurfaceState,
    pub activity: ActivitySurfaceState,
    pub model_plans: ModelPlansState,
    pub surfaces: Vec<InspectorSurface>,
}

impl InspectorRuntimeProjection {
    pub fn surface(&self, id: &str) -> Option<&InspectorSurface> {
        self.surfaces.iter().find(|surface| surface.id() == id)
    }

    pub fn surfaces(&self) -> &[InspectorSurface] {
        &self.surfaces
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct InspectorActionContext {
    pub thread_id: Option<String>,
    pub timestamp: String,
    pub started_at: u64,
    pub submission: Option<ComposerSubmission>,
    pub permission_options: BTreeMap<String, String>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum InspectorRuntimeIntent {
    Ui(InspectorAction),
    Runtime(RuntimeCommand),
    Host(HostCommand),
    Unavailable { capability: String, message: String },
}

pub fn project_service(
    service: &RuntimeService,
    input: &InspectorRuntimeInput,
) -> InspectorRuntimeProjection {
    project(&service.state, input)
}

pub fn project(
    runtime: &RuntimeState,
    input: &InspectorRuntimeInput,
) -> InspectorRuntimeProjection {
    let selected_thread_id = selected_thread_id(runtime);
    let thread = selected_thread_id
        .as_deref()
        .and_then(|id| project_thread(runtime, id));
    let mut pages = if input.context_pages.is_empty() {
        default_context_pages()
    } else {
        input.context_pages.clone()
    };
    pages.truncate(MAX_CONTEXT_PAGES);
    if pages.is_empty() {
        pages = default_context_pages();
    }
    let selected_page = selected_page(&pages, input.selected_context_page.as_deref());
    let disabled = input.disabled || runtime_disabled(runtime);
    let mode = project_mode(runtime, thread.as_ref(), disabled);
    let permission = project_permission(runtime, &selected_thread_id, disabled);
    let agents = project_agents(runtime, thread.as_ref());
    let active_agent = active_agent_id(thread.as_ref(), &agents);
    let agent_rail = project_agent_rail(runtime, agents.clone(), active_agent.clone(), disabled);
    let mut background = input
        .background
        .clone()
        .unwrap_or_else(|| project_background(runtime, disabled));
    normalize_background(&mut background, disabled);
    let tabs = project_tabs(runtime, &selected_thread_id, &agents, &input.cli, disabled);
    let transcript = thread
        .as_ref()
        .map(|value| transcript_items(&value.page))
        .unwrap_or_default();
    let agent = selected_agent(&agents, active_agent.as_deref(), thread.as_ref());
    let agent_panel = project_agent_panel(
        runtime,
        agent.clone(),
        transcript.clone(),
        input.now,
        disabled,
    );
    let thread_card = project_thread_card(runtime, thread.as_ref(), agent.clone(), disabled);
    let subagent_chips = project_subagent_chips(runtime, thread.as_ref(), &agents, disabled);
    let mut changes = input
        .changes
        .clone()
        .unwrap_or_else(|| project_changes(runtime, thread.as_ref(), disabled));
    normalize_changes(&mut changes, disabled);
    let context = project_context(
        runtime,
        thread.as_ref(),
        &selected_thread_id,
        selected_page,
        &pages,
        input,
        &agents,
        disabled,
    );
    let mut context_settings = input.context_settings.clone().unwrap_or_else(|| {
        project_context_settings(runtime, &pages, selected_page, input, disabled)
    });
    normalize_context_settings(&mut context_settings, disabled);
    let plan = project_plans(runtime, thread.as_ref(), &agents, disabled);
    let tasks = project_tasks(runtime, thread.as_ref(), disabled);
    let timeline = project_timeline(runtime, thread.as_ref(), input.now, disabled);
    let mut machine = input
        .machine
        .clone()
        .unwrap_or_else(|| project_machine(runtime, input.now, disabled));
    normalize_machine(&mut machine, disabled);
    let mut git_page = input
        .git
        .clone()
        .unwrap_or_else(|| project_git(runtime, thread.as_ref(), disabled));
    normalize_git_page(&mut git_page, disabled);
    let git = git_page.panel.clone();
    let mut cli = if input.cli.is_empty() {
        vec![project_cli(runtime, &selected_thread_id, disabled)]
    } else {
        input.cli.clone()
    };
    for run in &mut cli {
        run.disabled |= disabled;
    }
    let mut harness = input
        .harness
        .clone()
        .unwrap_or_else(|| project_harness(runtime, disabled));
    normalize_harness(&mut harness, disabled);
    let mut goal = input
        .goal
        .clone()
        .or_else(|| {
            project_goal(
                runtime,
                &selected_thread_id,
                thread.as_ref(),
                &agents,
                disabled,
            )
        })
        .unwrap_or_else(|| project_empty_goal(runtime, &selected_thread_id, disabled));
    normalize_goal(&mut goal, disabled);
    let mut activity = input
        .activity
        .clone()
        .unwrap_or_else(|| project_activity(runtime, disabled));
    normalize_activity(&mut activity, disabled);
    let mut model_plans = input
        .model_plans
        .clone()
        .unwrap_or_else(|| project_model_plans(runtime, disabled));
    normalize_model_plans(&mut model_plans, disabled);
    let surfaces = build_surfaces(
        &mode,
        &permission,
        &agent_rail,
        &background,
        &tabs,
        &agent_panel,
        &thread_card,
        &subagent_chips,
        &changes,
        &context,
        &context_settings,
        &plan,
        &tasks,
        &timeline,
        &machine,
        &git,
        &git_page,
        &cli,
        &harness,
        &goal,
        &activity,
        &model_plans,
    );
    InspectorRuntimeProjection {
        selected_thread_id,
        mode,
        permission,
        agent_rail,
        background,
        tabs,
        agent_panel,
        thread_card,
        subagent_chips,
        changes,
        context,
        context_settings,
        plan,
        tasks,
        timeline,
        machine,
        git,
        git_page,
        cli,
        harness,
        goal,
        activity,
        model_plans,
        surfaces,
    }
}

#[allow(clippy::too_many_arguments)]
fn build_surfaces(
    mode: &ModePickerState,
    permission: &PermissionPromptState,
    agent_rail: &AgentRailState,
    background: &BackgroundRailState,
    tabs: &TabStripState,
    agent_panel: &AgentPanelState,
    thread_card: &ThreadCardState,
    subagent_chips: &SubagentChipsState,
    changes: &ChangesPanelState,
    context: &ContextState,
    context_settings: &ContextSettingsState,
    plan: &PlanRailState,
    tasks: &TaskListState,
    timeline: &TimelineState,
    machine: &MachineSurfaceState,
    git: &GitPanelState,
    git_page: &GitPageState,
    cli: &[CliRunState],
    harness: &HarnessSurfaceState,
    goal: &GoalSurfaceState,
    activity: &ActivitySurfaceState,
    model_plans: &ModelPlansState,
) -> Vec<InspectorSurface> {
    let mut surfaces = vec![
        InspectorSurface::Mode(mode.clone()),
        InspectorSurface::Permission(permission.clone()),
        InspectorSurface::AgentRail(agent_rail.clone()),
        InspectorSurface::BackgroundRail(background.clone()),
        InspectorSurface::Tabs(tabs.clone()),
        InspectorSurface::AgentPanel(Box::new(agent_panel.clone())),
        InspectorSurface::ThreadCard(Box::new(thread_card.clone())),
        InspectorSurface::SubagentChips(Box::new(subagent_chips.clone())),
        InspectorSurface::Changes(Box::new(changes.clone())),
        InspectorSurface::Context(Box::new(context.clone())),
        InspectorSurface::ContextSettings(Box::new(context_settings.clone())),
        InspectorSurface::Plan(Box::new(plan.clone())),
        InspectorSurface::Tasks(Box::new(tasks.clone())),
        InspectorSurface::Timeline(Box::new(timeline.clone())),
        InspectorSurface::Machine(Box::new(machine.clone())),
        InspectorSurface::Git(Box::new(git.clone())),
        InspectorSurface::GitPage(Box::new(git_page.clone())),
    ];
    surfaces.extend(
        cli.iter()
            .cloned()
            .map(|state| InspectorSurface::Cli(Box::new(state))),
    );
    surfaces.extend([
        InspectorSurface::Harness(Box::new(harness.clone())),
        InspectorSurface::Goal(Box::new(goal.clone())),
        InspectorSurface::Activity(Box::new(activity.clone())),
        InspectorSurface::ModelPlans(Box::new(model_plans.clone())),
    ]);
    surfaces
}

fn selected_thread_id(runtime: &RuntimeState) -> Option<String> {
    runtime
        .selected_thread
        .as_deref()
        .filter(|id| runtime.threads.contains_key(*id))
        .map(str::to_owned)
        .or_else(|| {
            runtime
                .snapshot
                .as_ref()
                .and_then(|snapshot| {
                    snapshot
                        .threads
                        .iter()
                        .find(|thread| thread.archived_at.is_none())
                })
                .map(|thread| thread.id.clone())
        })
        .or_else(|| runtime.threads.keys().next().cloned())
}

fn summary_for<'a>(runtime: &'a RuntimeState, id: &str) -> Option<&'a HostThreadSummary> {
    runtime
        .snapshot
        .as_ref()?
        .threads
        .iter()
        .find(|thread| thread.id == id)
}

fn project_thread(runtime: &RuntimeState, id: &str) -> Option<RuntimeThread> {
    runtime.threads.get(id).cloned().or_else(|| {
        let summary = summary_for(runtime, id)?;
        let entries = summary
            .messages
            .as_deref()
            .map(host_entries)
            .unwrap_or_default();
        Some(RuntimeThread {
            id: summary.id.clone(),
            title: summary.title.clone(),
            page: crate::conversation::ConversationPage {
                thread_id: summary.id.clone(),
                thread_title: summary
                    .display_title
                    .clone()
                    .unwrap_or_else(|| summary.title.clone()),
                load_state: if summary.messages.is_none() {
                    ConversationLoadState::Loading
                } else if entries.is_empty() {
                    ConversationLoadState::Empty
                } else {
                    ConversationLoadState::Ready
                },
                entries,
                ..crate::conversation::ConversationPage::default()
            },
            active: None,
            queued: Default::default(),
            held: Default::default(),
            usage: RuntimeUsage::default(),
            context: RuntimeContext::default(),
            agents: BTreeMap::new(),
            plans: Vec::new(),
            tasks: Vec::new(),
            timeline: Vec::new(),
            routed_model: None,
            last_sequence: runtime.sequence,
        })
    })
}

fn runtime_disabled(runtime: &RuntimeState) -> bool {
    matches!(
        runtime.status,
        crate::runtime_services::ServiceStatus::Offline
            | crate::runtime_services::ServiceStatus::Restarting
    )
}

fn runtime_issue(runtime: &RuntimeState) -> Option<String> {
    runtime
        .last_error
        .as_ref()
        .map(|issue| issue.message.clone())
}

fn status_for(runtime: &RuntimeState, present: bool) -> InspectorStatus {
    match runtime.status {
        crate::runtime_services::ServiceStatus::Starting => InspectorStatus::Loading,
        crate::runtime_services::ServiceStatus::Restarting => {
            InspectorStatus::Disabled("The Emma runtime is restarting".to_owned())
        }
        crate::runtime_services::ServiceStatus::Offline => {
            InspectorStatus::Disabled("The Emma runtime is offline".to_owned())
        }
        crate::runtime_services::ServiceStatus::Degraded => runtime_issue(runtime)
            .map(InspectorStatus::Error)
            .unwrap_or_else(|| InspectorStatus::Error("The Emma runtime is degraded".to_owned())),
        crate::runtime_services::ServiceStatus::Ready => {
            if present {
                InspectorStatus::Ready
            } else {
                InspectorStatus::Empty
            }
        }
    }
}

fn disabled_status(runtime: &RuntimeState, disabled: bool) -> bool {
    disabled || runtime_disabled(runtime)
}

fn normalize_status(status: &mut InspectorStatus, disabled: bool, message: &str) {
    if disabled && !status.is_disabled() {
        *status = InspectorStatus::Disabled(message.to_owned());
    }
}

fn normalize_background(state: &mut BackgroundRailState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Background tasks are unavailable",
    );
}

fn normalize_changes(state: &mut ChangesPanelState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(&mut state.status, state.disabled, "Changes are unavailable");
}

fn normalize_context_settings(state: &mut ContextSettingsState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Context bar settings are unavailable",
    );
}

fn normalize_machine(state: &mut MachineSurfaceState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Machine metrics are unavailable",
    );
}

fn normalize_git_page(state: &mut GitPageState, disabled: bool) {
    state.panel.disabled |= disabled;
    normalize_status(
        &mut state.panel.status,
        state.panel.disabled,
        "Git data is unavailable",
    );
}

fn normalize_harness(state: &mut HarnessSurfaceState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Harness data is unavailable",
    );
}

fn normalize_goal(state: &mut GoalSurfaceState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Goal data is unavailable",
    );
}

fn normalize_activity(state: &mut ActivitySurfaceState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Activity data is unavailable",
    );
}

fn normalize_model_plans(state: &mut ModelPlansState, disabled: bool) {
    state.disabled |= disabled;
    normalize_status(
        &mut state.status,
        state.disabled,
        "Model plan credentials are unavailable",
    );
}

fn selected_page<'a>(
    pages: &'a [ContextPageSource],
    requested: Option<&str>,
) -> &'a ContextPageSource {
    pages
        .iter()
        .find(|page| Some(page.id.as_str()) == requested)
        .or_else(|| pages.first())
        .expect("context pages always include a default page")
}

fn widget(
    id: &str,
    label: &str,
    glyph: &str,
    orientation: &str,
    metrics: &[&str],
) -> ContextWidgetSnapshot {
    ContextWidgetSnapshot {
        id: id.to_owned(),
        label: label.to_owned(),
        glyph: glyph.to_owned(),
        orientation: orientation.to_owned(),
        metrics: metrics.iter().map(|metric| (*metric).to_owned()).collect(),
    }
}

fn default_context_pages() -> Vec<ContextPageSource> {
    let stats = [
        "messages",
        "replies",
        "attachments",
        "calls",
        "rate",
        "output",
        "cache",
        "cacheWrites",
        "cost",
    ];
    vec![
        ContextPageSource {
            id: "p1".to_owned(),
            name: "Context".to_owned(),
            widgets: vec![
                widget("stats", "Thread stats", "▦", "horizontal", &stats),
                widget("context", "Context window", "▤", "vertical", &[]),
                widget("timeline", "Timeline", "⌇", "vertical", &[]),
                widget("tasklist", "Tasks", "☷", "vertical", &[]),
                widget("plan", "Plan", "◰", "vertical", &[]),
                widget("subagents", "Subagents", "⌸", "vertical", &[]),
                widget("subthreads", "Sub threads", "⑃", "vertical", &[]),
            ],
        },
        ContextPageSource {
            id: "p2".to_owned(),
            name: "Run".to_owned(),
            widgets: vec![
                widget("timeline", "Timeline", "⌇", "vertical", &[]),
                widget("tasklist", "Tasks", "☷", "vertical", &[]),
                widget("plan", "Plan", "◰", "vertical", &[]),
                widget("subagents", "Subagents", "⌸", "vertical", &[]),
                widget("subthreads", "Sub threads", "⑃", "vertical", &[]),
                widget("git", "Git", "⑂", "vertical", &[]),
            ],
        },
        ContextPageSource {
            id: "p3".to_owned(),
            name: "Machine".to_owned(),
            widgets: vec![
                widget("machinemeters", "Machine meters", "▥", "vertical", &[]),
                widget("machinegraph", "Machine graph", "∿", "vertical", &[]),
                widget("machine", "Machine", "◫", "horizontal", &[]),
            ],
        },
    ]
}

fn all_context_widgets() -> Vec<ContextWidgetSnapshot> {
    let stats = [
        "messages",
        "replies",
        "attachments",
        "calls",
        "rate",
        "output",
        "cache",
        "cacheWrites",
        "cost",
    ];
    vec![
        widget("stats", "Thread stats", "▦", "horizontal", &stats),
        widget("context", "Context window", "▤", "vertical", &[]),
        widget("timeline", "Timeline", "⌇", "vertical", &[]),
        widget("tasklist", "Tasks", "☷", "vertical", &[]),
        widget("plan", "Plan", "◰", "vertical", &[]),
        widget("subagents", "Subagents", "⌸", "vertical", &[]),
        widget("subthreads", "Sub threads", "⑃", "vertical", &[]),
        widget("machine", "Machine", "◫", "vertical", &[]),
        widget("machinegraph", "Machine graph", "∿", "vertical", &[]),
        widget("machinemeters", "Machine meters", "▥", "vertical", &[]),
        widget("git", "Git", "⑂", "vertical", &[]),
    ]
}

fn project_context_settings(
    runtime: &RuntimeState,
    pages: &[ContextPageSource],
    selected: &ContextPageSource,
    _input: &InspectorRuntimeInput,
    disabled: bool,
) -> ContextSettingsState {
    let active_types = selected
        .widgets
        .iter()
        .map(|widget| widget.id.as_str())
        .collect::<HashSet<_>>();
    let spare = all_context_widgets()
        .into_iter()
        .filter(|widget| !active_types.contains(widget.id.as_str()))
        .collect::<Vec<_>>();
    ContextSettingsState {
        status: status_for(runtime, !pages.is_empty()),
        pages: pages.iter().map(|page| page.name.clone()).collect(),
        active_page: selected.name.clone(),
        page_name: selected.name.clone(),
        widgets: selected.widgets.clone(),
        spare,
        editing: false,
        adding: false,
        busy: false,
        disabled: disabled_status(runtime, disabled),
    }
}

fn project_mode(
    _runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    disabled: bool,
) -> ModePickerState {
    let mode = thread
        .and_then(|thread| thread.active.as_ref().map(|active| active.submission.mode))
        .or_else(|| thread.map(|thread| thread.page.composer.mode))
        .unwrap_or_default();
    ModePickerState {
        mode,
        open: thread.is_some() && !disabled,
        active: PermissionMode::ALL
            .iter()
            .position(|candidate| *candidate == mode)
            .unwrap_or(0),
        disabled,
    }
}

fn project_permission(
    runtime: &RuntimeState,
    selected_thread_id: &Option<String>,
    disabled: bool,
) -> PermissionPromptState {
    let request = runtime.permissions.values().find(|request| {
        selected_thread_id.as_deref() == Some(request.thread_id.as_str())
            || runtime
                .threads
                .get(selected_thread_id.as_deref().unwrap_or_default())
                .is_some_and(|thread| {
                    thread
                        .agents
                        .values()
                        .any(|agent| agent.id == request.thread_id)
                })
    });
    let request = request.map(|request| PermissionRequest {
        id: request.id.clone(),
        thread_id: request.thread_id.clone(),
        tool: request.tool.clone(),
        source_title: runtime
            .threads
            .values()
            .flat_map(|thread| thread.agents.values())
            .find(|agent| agent.id == request.thread_id)
            .map(|agent| agent.title.clone())
            .or_else(|| {
                selected_thread_id
                    .as_deref()
                    .and_then(|id| runtime.threads.get(id))
                    .map(|thread| thread.title.clone())
            })
            .unwrap_or_default(),
        mode: request.mode,
        summary: request.title.clone(),
        detail: request.detail.clone(),
        focus_allow: !request.options.is_empty(),
    });
    PermissionPromptState {
        status: if request.is_some() {
            status_for(runtime, true)
        } else if disabled {
            InspectorStatus::Disabled("Permission handling is unavailable".to_owned())
        } else {
            InspectorStatus::Empty
        },
        request,
        disabled,
    }
}

fn agent_mode(runtime: &RuntimeState, update: &RuntimeAgentUpdate) -> PermissionMode {
    runtime
        .threads
        .values()
        .find(|thread| thread.agents.contains_key(&update.id))
        .and_then(|thread| {
            thread
                .active
                .as_ref()
                .map(|active| active.submission.mode)
                .or(Some(thread.page.composer.mode))
        })
        .unwrap_or_default()
}

fn fallback_agent(thread: &RuntimeThread) -> AgentSnapshot {
    let status = match thread.page.run.state {
        RunState::Waiting => "waiting",
        RunState::Streaming | RunState::Stalled => "running",
        RunState::Failed => "failed",
        RunState::Stopped => "stopped",
        RunState::Idle => "idle",
    };
    let submission = thread.active.as_ref().map(|active| &active.submission);
    AgentSnapshot {
        id: thread.id.clone(),
        parent_id: None,
        title: if thread.title.is_empty() {
            "Emma".to_owned()
        } else {
            thread.title.clone()
        },
        color: "#4f9dff".to_owned(),
        status: status.to_owned(),
        mode: submission.map_or(thread.page.composer.mode, |value| value.mode),
        model: submission
            .map(|value| value.model.clone())
            .filter(|value| !value.is_empty())
            .or_else(|| thread.routed_model.clone())
            .unwrap_or_default(),
        effort: None,
        activity: if thread.page.run.activity.is_empty() {
            status.to_owned()
        } else {
            thread.page.run.activity.clone()
        },
        prompt: submission.map_or(String::new(), |value| value.text.clone()),
        tool: thread.page.run.working_call,
        started_at: thread.active.as_ref().map_or(0, |active| active.started_at),
        ended_at: None,
        steps: thread.page.run.blocks.len(),
        tool_calls: thread
            .page
            .run
            .blocks
            .iter()
            .filter(|block| matches!(block, ConversationBlock::Tool(_)))
            .count(),
        input_tokens: usize::try_from(thread.usage.input_tokens).unwrap_or(usize::MAX),
        output_tokens: usize::try_from(thread.usage.output_tokens).unwrap_or(usize::MAX),
        generation_ms: 0,
        error: thread.page.run.error.clone(),
    }
}

fn agent_snapshot(
    runtime: &RuntimeState,
    update: &RuntimeAgentUpdate,
    index: usize,
) -> AgentSnapshot {
    AgentSnapshot {
        id: update.id.clone(),
        parent_id: update.parent_id.clone(),
        title: if update.title.is_empty() {
            update.brief.clone()
        } else {
            update.title.clone()
        },
        color: update.color.clone().unwrap_or_else(|| agent_color(index)),
        status: update.status.id().to_owned(),
        mode: agent_mode(runtime, update),
        model: update.model.clone().unwrap_or_default(),
        effort: update.effort.clone(),
        activity: update
            .activity
            .clone()
            .unwrap_or_else(|| update.brief.clone()),
        prompt: update
            .prompt
            .clone()
            .unwrap_or_else(|| update.brief.clone()),
        tool: update.tool,
        started_at: update.started_at,
        ended_at: update.ended_at,
        steps: update.steps,
        tool_calls: update.tool_calls,
        input_tokens: update.input_tokens,
        output_tokens: update.output_tokens,
        generation_ms: update.generation_ms,
        error: update.error.clone(),
    }
}

fn project_agents(runtime: &RuntimeState, selected: Option<&RuntimeThread>) -> Vec<AgentSnapshot> {
    let mut updates = BTreeMap::<String, RuntimeAgentUpdate>::new();
    for thread in runtime.threads.values() {
        for update in thread.agents.values() {
            updates
                .entry(update.id.clone())
                .or_insert_with(|| update.clone());
        }
    }
    let mut agents = updates
        .values()
        .enumerate()
        .map(|(index, update)| agent_snapshot(runtime, update, index))
        .collect::<Vec<_>>();
    if let Some(thread) = selected
        && thread.active.is_some()
        && !agents.iter().any(|agent| agent.id == thread.id)
    {
        agents.insert(0, fallback_agent(thread));
    }
    agents.sort_by(|left, right| left.id.cmp(&right.id));
    agents
}

fn active_agent_id(thread: Option<&RuntimeThread>, agents: &[AgentSnapshot]) -> Option<String> {
    thread
        .and_then(|thread| {
            thread
                .agents
                .values()
                .find(|agent| {
                    matches!(
                        agent.status,
                        NestedAgentStatus::Running | NestedAgentStatus::Waiting
                    )
                })
                .map(|agent| agent.id.clone())
        })
        .or_else(|| {
            agents
                .iter()
                .find(|agent| agent.alive())
                .map(|agent| agent.id.clone())
        })
}

fn project_agent_rail(
    runtime: &RuntimeState,
    agents: Vec<AgentSnapshot>,
    active: Option<String>,
    disabled: bool,
) -> AgentRailState {
    let present = agents.iter().any(AgentSnapshot::alive);
    AgentRailState {
        status: status_for(runtime, present),
        agents,
        active,
        disabled,
    }
}

fn selected_agent(
    agents: &[AgentSnapshot],
    active: Option<&str>,
    thread: Option<&RuntimeThread>,
) -> Option<AgentSnapshot> {
    active
        .and_then(|id| agents.iter().find(|agent| agent.id == id))
        .cloned()
        .or_else(|| agents.iter().find(|agent| agent.alive()).cloned())
        .or_else(|| thread.map(fallback_agent))
}

fn empty_agent() -> AgentSnapshot {
    AgentSnapshot {
        id: "agent".to_owned(),
        parent_id: None,
        title: "Emma".to_owned(),
        color: "#4f9dff".to_owned(),
        status: "idle".to_owned(),
        mode: PermissionMode::Ask,
        model: String::new(),
        effort: None,
        activity: "idle".to_owned(),
        prompt: String::new(),
        tool: false,
        started_at: 0,
        ended_at: None,
        steps: 0,
        tool_calls: 0,
        input_tokens: 0,
        output_tokens: 0,
        generation_ms: 0,
        error: None,
    }
}

fn project_agent_panel(
    runtime: &RuntimeState,
    agent: Option<AgentSnapshot>,
    transcript: Vec<TranscriptItem>,
    now: u64,
    disabled: bool,
) -> AgentPanelState {
    let present = agent.is_some();
    let agent = agent.unwrap_or_else(empty_agent);
    AgentPanelState {
        status: status_for(runtime, present),
        error: agent.error.clone(),
        agent,
        transcript,
        steer: String::new(),
        now,
        disabled,
    }
}

fn project_tabs(
    runtime: &RuntimeState,
    selected_thread_id: &Option<String>,
    agents: &[AgentSnapshot],
    cli: &[CliRunState],
    disabled: bool,
) -> TabStripState {
    let mut ids = BTreeMap::<String, AgentTabSnapshot>::new();
    if let Some(snapshot) = runtime.snapshot.as_ref() {
        for summary in &snapshot.threads {
            if summary.archived_at.is_some() {
                continue;
            }
            let label = summary
                .display_title
                .clone()
                .unwrap_or_else(|| summary.title.clone());
            ids.insert(
                summary.id.clone(),
                AgentTabSnapshot {
                    id: summary.id.clone(),
                    label,
                    color: agents
                        .iter()
                        .find(|agent| agent.id == summary.id)
                        .map(|agent| agent.color.clone()),
                    icon: None,
                    closable: selected_thread_id.as_deref() != Some(summary.id.as_str()),
                },
            );
        }
    }
    for thread in runtime.threads.values() {
        ids.entry(thread.id.clone())
            .or_insert_with(|| AgentTabSnapshot {
                id: thread.id.clone(),
                label: thread.page.thread_title.clone(),
                color: agents
                    .iter()
                    .find(|agent| agent.id == thread.id)
                    .map(|agent| agent.color.clone()),
                icon: None,
                closable: selected_thread_id.as_deref() != Some(thread.id.as_str()),
            });
    }
    for run in cli {
        ids.insert(
            run.id.clone(),
            AgentTabSnapshot {
                id: run.id.clone(),
                label: if run.label.is_empty() {
                    run.title.clone()
                } else {
                    run.label.clone()
                },
                color: None,
                icon: Some("⌘".to_owned()),
                closable: true,
            },
        );
    }
    let tabs = ids.into_values().collect::<Vec<_>>();
    let active = selected_thread_id
        .clone()
        .or_else(|| tabs.first().map(|tab| tab.id.clone()))
        .unwrap_or_default();
    TabStripState {
        status: status_for(runtime, !tabs.is_empty()),
        tabs,
        active,
        disabled,
    }
}

fn transcript_items(page: &crate::conversation::ConversationPage) -> Vec<TranscriptItem> {
    let mut items = Vec::new();
    for entry in &page.entries {
        match entry {
            ConversationEntry::Message(message) => {
                items.push(TranscriptItem {
                    id: message.id.clone(),
                    role: message.role.id().to_owned(),
                    text: message.content.clone(),
                    status: message.generation.as_ref().map(|_| "done".to_owned()),
                });
                for block in &message.blocks {
                    if let ConversationBlock::Tool(tool) = block {
                        items.push(TranscriptItem {
                            id: tool.id.clone(),
                            role: "tool".to_owned(),
                            text: tool.label(),
                            status: Some(tool.status.id().to_owned()),
                        });
                    }
                }
            }
            ConversationEntry::ContextCut { id } => items.push(TranscriptItem {
                id: id.clone(),
                role: "context".to_owned(),
                text: "Context compacted".to_owned(),
                status: None,
            }),
            ConversationEntry::ModelCut(mark) => items.push(TranscriptItem {
                id: mark.id.clone(),
                role: "model".to_owned(),
                text: mark.label.clone(),
                status: None,
            }),
        }
    }
    append_run_items(&mut items, &page.run);
    items
}

fn append_run_items(items: &mut Vec<TranscriptItem>, run: &ConversationRun) {
    for block in &run.blocks {
        match block {
            ConversationBlock::Markdown { id, text } => items.push(TranscriptItem {
                id: id.clone(),
                role: "assistant".to_owned(),
                text: text.clone(),
                status: Some("streaming".to_owned()),
            }),
            ConversationBlock::Thinking(thinking) => items.push(TranscriptItem {
                id: thinking.id.clone(),
                role: "thinking".to_owned(),
                text: thinking.text.clone(),
                status: Some(if thinking.live.is_some() {
                    "thinking".to_owned()
                } else {
                    "done".to_owned()
                }),
            }),
            ConversationBlock::Tool(tool) => items.push(TranscriptItem {
                id: tool.id.clone(),
                role: "tool".to_owned(),
                text: tool.label(),
                status: Some(tool.status.id().to_owned()),
            }),
            ConversationBlock::Notice { id, text, .. } => items.push(TranscriptItem {
                id: id.clone(),
                role: "notice".to_owned(),
                text: text.clone(),
                status: None,
            }),
            ConversationBlock::Visual(visual) => items.push(TranscriptItem {
                id: visual.id.clone(),
                role: "visual".to_owned(),
                text: visual.caption.clone(),
                status: None,
            }),
        }
    }
}

fn project_thread_card(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    agent: Option<AgentSnapshot>,
    disabled: bool,
) -> ThreadCardState {
    let (id, title, message, active) = thread.map_or_else(
        || (String::new(), "New thread".to_owned(), String::new(), false),
        |thread| {
            (
                thread.id.clone(),
                thread.page.thread_title.clone(),
                thread
                    .active
                    .as_ref()
                    .map(|active| active.submission.text.clone())
                    .unwrap_or_default(),
                thread.active.is_some(),
            )
        },
    );
    ThreadCardState {
        status: status_for(runtime, thread.is_some()),
        id,
        title,
        agent,
        message,
        sent: None,
        error: None,
        disabled: disabled || !active,
    }
}

fn project_subagent_chips(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    agents: &[AgentSnapshot],
    disabled: bool,
) -> SubagentChipsState {
    let thread_id = thread.map(|thread| thread.id.as_str()).unwrap_or_default();
    let mut chips = agents
        .iter()
        .filter(|agent| agent.parent_id.as_deref() == Some(thread_id))
        .map(|agent| SubagentChip {
            id: agent.id.clone(),
            name: agent.title.clone(),
            brief: agent.prompt.clone(),
            color: agent.color.clone(),
            status: agent.status.clone(),
            activity: (!agent.activity.is_empty()).then(|| agent.activity.clone()),
        })
        .collect::<Vec<_>>();
    if let Some(thread) = thread {
        for message in thread.page.entries.iter().filter_map(message_entry) {
            for nested in &message.spawned {
                if chips.iter().any(|chip| chip.id == nested.id) {
                    continue;
                }
                chips.push(SubagentChip {
                    id: nested.id.clone(),
                    name: nested.name.clone(),
                    brief: nested.brief.clone(),
                    color: nested
                        .color
                        .clone()
                        .unwrap_or_else(|| agent_color(chips.len())),
                    status: nested.status.id().to_owned(),
                    activity: nested.activity.clone(),
                });
            }
        }
    }
    SubagentChipsState {
        status: status_for(runtime, !chips.is_empty()),
        chips,
        done_open: false,
        disabled,
    }
}

fn message_entry(entry: &ConversationEntry) -> Option<&ConversationMessage> {
    match entry {
        ConversationEntry::Message(message) => Some(message),
        ConversationEntry::ContextCut { .. } | ConversationEntry::ModelCut(_) => None,
    }
}

fn project_background(runtime: &RuntimeState, disabled: bool) -> BackgroundRailState {
    BackgroundRailState {
        status: status_for(runtime, false),
        tasks: Vec::new(),
        open: None,
        disabled,
    }
}

fn project_changes(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    disabled: bool,
) -> ChangesPanelState {
    let changes = thread.map(thread_changes).unwrap_or_default();
    ChangesPanelState {
        status: status_for(runtime, !changes.is_empty()),
        changes,
        busy: false,
        error: None,
        disabled,
    }
}

fn thread_changes(thread: &RuntimeThread) -> Vec<FileChangeSnapshot> {
    let mut changes = BTreeMap::<String, FileChangeSnapshot>::new();
    for entry in &thread.page.entries {
        if let ConversationEntry::Message(message) = entry {
            for block in &message.blocks {
                collect_change(&mut changes, block);
            }
        }
    }
    for block in &thread.page.run.blocks {
        collect_change(&mut changes, block);
    }
    changes.into_values().collect()
}

fn collect_change(changes: &mut BTreeMap<String, FileChangeSnapshot>, block: &ConversationBlock) {
    let ConversationBlock::Tool(tool) = block else {
        return;
    };
    let Some(edit) = &tool.edit else {
        return;
    };
    let path = if edit.path.is_empty() {
        tool.path.clone().unwrap_or_default()
    } else {
        edit.path.clone()
    };
    if path.is_empty() {
        return;
    }
    changes.insert(path.clone(), change_from_edit(edit));
}

fn change_from_edit(edit: &EditDiff) -> FileChangeSnapshot {
    let lines = edit
        .hunks
        .iter()
        .map(|line| ChangeLine {
            kind: line.kind.mark().chars().next().unwrap_or(' '),
            text: line.text.clone(),
        })
        .collect::<Vec<_>>();
    let after = edit
        .hunks
        .iter()
        .filter(|line| line.kind != crate::conversation::DiffLineKind::Removed)
        .map(|line| line.text.clone())
        .collect::<Vec<_>>()
        .join("\n");
    FileChangeSnapshot {
        folder_id: String::new(),
        path: edit.path.clone(),
        before: None,
        after,
        added: edit.added,
        removed: edit.removed,
        lines,
    }
}

fn host_entries(messages: &[HostMessage]) -> Vec<ConversationEntry> {
    messages
        .iter()
        .enumerate()
        .map(|(index, message)| {
            let mut converted = ConversationMessage::new(
                format!("message-{index}"),
                message.role,
                message.content.clone(),
                message.timestamp.clone(),
            );
            if let Some(generation) = &message.generation {
                converted.generation = Some(GenerationMeta {
                    model: generation.model.clone(),
                    output_tokens: usize::try_from(generation.output_tokens).unwrap_or(usize::MAX),
                    duration_ms: generation.duration_milliseconds,
                    input_tokens: usize::try_from(generation.input_tokens).unwrap_or(usize::MAX),
                });
            }
            if message.role == ConversationRole::Assistant {
                let (answer, thought) = split_thinking(&message.content);
                converted.content = answer;
                if !thought.trim().is_empty() {
                    converted
                        .blocks
                        .push(ConversationBlock::Thinking(ThinkingBlock {
                            id: format!("message-{index}-thinking"),
                            text: thought.clone(),
                            duration_ms: 0,
                            tokens: thought_tokens(&thought),
                            live: None,
                        }));
                }
                if !converted.content.is_empty() {
                    converted.blocks.push(ConversationBlock::Markdown {
                        id: format!("message-{index}-markdown"),
                        text: converted.content.clone(),
                    });
                }
            }
            ConversationEntry::Message(converted)
        })
        .collect()
}

fn agent_color(index: usize) -> String {
    [
        "#4f9dff", "#f2a13c", "#57c785", "#c77dff", "#ff6b81", "#3fc7d4", "#e0c341", "#8f9bff",
    ][index % 8]
        .to_owned()
}

#[allow(clippy::too_many_arguments)]
fn project_context(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    _selected_thread_id: &Option<String>,
    selected_page: &ContextPageSource,
    _pages: &[ContextPageSource],
    input: &InspectorRuntimeInput,
    agents: &[AgentSnapshot],
    disabled: bool,
) -> ContextState {
    let Some(thread) = thread else {
        return ContextState {
            status: if disabled {
                InspectorStatus::Disabled("Context data is unavailable".to_owned())
            } else {
                status_for(runtime, false)
            },
            page_name: selected_page.name.clone(),
            orientation: "vertical".to_owned(),
            disabled,
            ..ContextState::default()
        };
    };
    let (rows, total_chars, messages, replies, attachments, calls, output_tokens, elapsed_ms) =
        context_rows(thread);
    let threads = project_context_threads(runtime, &thread.id, agents);
    let total_tokens = total_chars / CONTEXT_CHARS_PER_TOKEN;
    let capacity_tokens = input.context_capacity_tokens;
    let free_tokens = capacity_tokens.map(|capacity| capacity.saturating_sub(total_tokens));
    let whole_chars = capacity_tokens
        .map(|capacity| capacity.saturating_mul(CONTEXT_CHARS_PER_TOKEN))
        .unwrap_or(total_chars);
    let largest = rows.iter().max_by_key(|row| row.chars);
    let mut metric_ids = if input.context_metrics.is_empty() {
        selected_page
            .widgets
            .iter()
            .find(|widget| widget.id == "stats")
            .filter(|widget| !widget.metrics.is_empty())
            .map(|widget| {
                widget
                    .metrics
                    .iter()
                    .map(String::as_str)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_else(|| {
                vec![
                    "messages",
                    "replies",
                    "attachments",
                    "calls",
                    "rate",
                    "output",
                    "cache",
                    "cacheWrites",
                    "cost",
                ]
            })
    } else {
        input
            .context_metrics
            .iter()
            .map(String::as_str)
            .collect::<Vec<_>>()
    };
    metric_ids.truncate(MAX_CONTEXT_METRICS);
    let metrics = metric_ids
        .into_iter()
        .map(|id| ContextMetricSnapshot {
            id: id.to_owned(),
            label: metric_label(id).to_owned(),
            value: metric_value(
                id,
                messages,
                replies,
                attachments,
                calls,
                output_tokens,
                elapsed_ms,
                total_tokens,
                capacity_tokens,
                free_tokens,
                whole_chars,
                largest.map(|row| row.chars),
                agents,
                thread,
                threads.len(),
            ),
            title: metric_title(id, thread),
        })
        .collect::<Vec<_>>();
    let curve = if input.context_curve.is_empty() {
        let rate = if elapsed_ms == 0 {
            0.
        } else {
            output_tokens as f32 / (elapsed_ms as f32 / 1_000.)
        };
        if rate > 0. {
            vec![ContextCurvePoint {
                context: total_tokens,
                turns: replies,
                rate,
            }]
        } else {
            Vec::new()
        }
    } else {
        input.context_curve.clone()
    };
    let child_agents = agents
        .iter()
        .filter(|agent| agent.parent_id.as_deref() == Some(thread.id.as_str()))
        .map(|agent| ContextAgentRow {
            id: agent.id.clone(),
            title: agent.title.clone(),
            status: agent.status.clone(),
            activity: agent.activity.clone(),
            color: Some(agent.color.clone()),
            model: (!agent.model.is_empty()).then(|| agent.model.clone()),
            parent_id: agent.parent_id.clone(),
        })
        .collect::<Vec<_>>();
    let status = match &thread.page.load_state {
        ConversationLoadState::Loading => InspectorStatus::Loading,
        ConversationLoadState::Error(error) => InspectorStatus::Error(error.clone()),
        ConversationLoadState::Ready | ConversationLoadState::Empty => status_for(runtime, true),
    };
    let orientation = selected_page
        .widgets
        .iter()
        .find(|widget| widget.id == "context")
        .map(|widget| widget.orientation.clone())
        .unwrap_or_else(|| "vertical".to_owned());
    ContextState {
        status,
        page_name: selected_page.name.clone(),
        orientation,
        metrics,
        curve,
        curve_open: input.context_curve_open,
        total_tokens: token_label(total_tokens),
        capacity_tokens: capacity_tokens.map(token_label),
        free_tokens: free_tokens.map(token_label),
        used_share: capacity_tokens.map(|_| share_label(total_chars, whole_chars)),
        rows,
        experiments: input.context_experiments.clone(),
        agents: child_agents,
        done_agents_open: input.context_agents_open,
        threads,
        git_available: thread.page.git_available,
        expanded: input.context_ledger_expanded,
        show_all: input.context_show_all,
        disabled,
    }
}

fn context_rows(
    thread: &RuntimeThread,
) -> (
    Vec<ContextLedgerRow>,
    usize,
    usize,
    usize,
    usize,
    usize,
    usize,
    u64,
) {
    let messages = thread
        .page
        .entries
        .iter()
        .filter_map(message_entry)
        .collect::<Vec<_>>();
    let message_chars = messages
        .iter()
        .map(|message| message.content.len())
        .sum::<usize>();
    let message_turns = messages
        .iter()
        .filter(|message| message.role == ConversationRole::User)
        .count();
    let replies = messages
        .iter()
        .filter(|message| message.role == ConversationRole::Assistant)
        .count();
    let attachments = messages
        .iter()
        .map(|message| message.attachments.len())
        .sum::<usize>();
    let mut calls = messages
        .iter()
        .flat_map(|message| message.blocks.iter())
        .filter(|block| matches!(block, ConversationBlock::Tool(_)))
        .count();
    calls += thread
        .page
        .run
        .blocks
        .iter()
        .filter(|block| matches!(block, ConversationBlock::Tool(_)))
        .count();
    let output_tokens = usize::try_from(thread.usage.output_tokens).unwrap_or(usize::MAX);
    let elapsed_ms = messages
        .iter()
        .filter_map(|message| message.generation.as_ref())
        .map(|generation| generation.duration_ms)
        .sum::<u64>();
    let mut source_rows = Vec::<(String, String, usize, usize, Vec<String>)>::new();
    if message_chars > 0 || !messages.is_empty() {
        source_rows.push((
            "messages".to_owned(),
            "Messages".to_owned(),
            message_chars,
            message_turns,
            messages
                .iter()
                .take(8)
                .map(|message| {
                    format!(
                        "{} · {}",
                        message.role.label(),
                        compact_text(&message.content)
                    )
                })
                .collect(),
        ));
    }
    add_context_row(
        &mut source_rows,
        "system",
        "System prompt",
        thread.context.system_prompt_bytes,
        replies,
    );
    add_context_row(
        &mut source_rows,
        "tools",
        "System tools",
        thread.context.system_tools_bytes,
        replies,
    );
    add_context_row(
        &mut source_rows,
        "mcp",
        "MCP tools",
        thread.context.mcp_tools_bytes,
        replies,
    );
    add_context_row(
        &mut source_rows,
        "skills",
        "Skills",
        thread.context.skills_bytes,
        replies,
    );
    add_context_row(
        &mut source_rows,
        "memory",
        "Memory files",
        thread.context.memory_bytes,
        replies,
    );
    let named = source_rows.iter().map(|row| row.2).sum::<usize>();
    let anchor = usize::try_from(thread.usage.input_tokens)
        .unwrap_or(usize::MAX)
        .saturating_mul(CONTEXT_CHARS_PER_TOKEN);
    let scale = if anchor > 0 && named > anchor {
        anchor as f32 / named as f32
    } else {
        1.
    };
    if scale != 1. {
        for row in &mut source_rows {
            row.2 = (row.2 as f32 * scale).round() as usize;
        }
    }
    let scaled = source_rows.iter().map(|row| row.2).sum::<usize>();
    if anchor > scaled {
        source_rows.push((
            "messages".to_owned(),
            if thread.active.is_some() {
                format!("This turn · {calls} {}", plural(calls, "tool call"))
            } else {
                "Tool results & retries".to_owned()
            },
            anchor - scaled,
            if thread.active.is_some() { 1 } else { replies },
            Vec::new(),
        ));
    }
    source_rows.sort_by_key(|right| std::cmp::Reverse(right.2));
    if source_rows.len() > MAX_CONTEXT_ROWS {
        let rest = source_rows
            .drain(MAX_CONTEXT_ROWS - 1..)
            .collect::<Vec<_>>();
        let chars = rest.iter().map(|row| row.2).sum::<usize>();
        let turns = rest.iter().map(|row| row.3).sum::<usize>();
        source_rows.push((
            "messages".to_owned(),
            "Other context".to_owned(),
            chars,
            turns,
            Vec::new(),
        ));
    }
    let rows = source_rows
        .into_iter()
        .map(|(kind, label, chars, turns, detail)| ContextLedgerRow {
            id: format!("{kind}:{label}"),
            kind,
            label,
            chars,
            tokens: token_label(chars / CONTEXT_CHARS_PER_TOKEN),
            share: String::new(),
            turns,
            detail,
            expanded: false,
        })
        .collect::<Vec<_>>();
    let total = rows.iter().map(|row| row.chars).sum::<usize>();
    let whole = if anchor > 0 { anchor } else { total };
    let rows = rows
        .into_iter()
        .map(|mut row| {
            row.share = share_label(row.chars, whole);
            row
        })
        .collect::<Vec<_>>();
    (
        rows,
        total,
        messages.len(),
        replies,
        attachments,
        calls,
        output_tokens,
        elapsed_ms,
    )
}

fn add_context_row(
    rows: &mut Vec<(String, String, usize, usize, Vec<String>)>,
    kind: &str,
    label: &str,
    bytes: u64,
    turns: usize,
) {
    let chars = usize::try_from(bytes).unwrap_or(usize::MAX);
    if chars > 0 {
        rows.push((kind.to_owned(), label.to_owned(), chars, turns, Vec::new()));
    }
}

fn compact_text(value: &str) -> String {
    let compact = value.split_whitespace().collect::<Vec<_>>().join(" ");
    compact.chars().take(96).collect()
}

fn token_label(tokens: usize) -> String {
    if tokens == 0 {
        return "—".to_owned();
    }
    if tokens >= 1_000_000 {
        format!("{:.1}m", tokens as f32 / 1_000_000.)
    } else if tokens >= 1_000 {
        format!("{:.1}k", tokens as f32 / 1_000.)
    } else {
        tokens.to_string()
    }
}

fn share_label(part: usize, whole: usize) -> String {
    if whole == 0 {
        "—".to_owned()
    } else {
        format!("{:.1}%", part as f32 / whole as f32 * 100.)
    }
}

fn plural(count: usize, singular: &str) -> String {
    if count == 1 {
        singular.to_owned()
    } else {
        format!("{singular}s")
    }
}

#[allow(clippy::too_many_arguments)]
fn metric_value(
    id: &str,
    messages: usize,
    replies: usize,
    attachments: usize,
    calls: usize,
    output_tokens: usize,
    elapsed_ms: u64,
    total_tokens: usize,
    capacity_tokens: Option<usize>,
    free_tokens: Option<usize>,
    whole_chars: usize,
    largest_chars: Option<usize>,
    agents: &[AgentSnapshot],
    thread: &RuntimeThread,
    subthreads: usize,
) -> String {
    match id {
        "messages" => messages
            .saturating_add(usize::from(thread.active.is_some()) * 2)
            .to_string(),
        "replies" => replies
            .saturating_add(usize::from(thread.active.is_some()))
            .to_string(),
        "attachments" => attachments.to_string(),
        "calls" => calls.to_string(),
        "rate" => {
            if elapsed_ms == 0 {
                "—".to_owned()
            } else {
                ((output_tokens as f32 / (elapsed_ms as f32 / 1_000.)).round() as usize).to_string()
            }
        }
        "output" => token_label(output_tokens),
        "cache" => match (
            thread.usage.cache_input_tokens,
            thread.usage.cache_read_tokens,
        ) {
            (Some(input), Some(read)) if input > 0 => {
                format!("{}%", (read as f32 / input as f32 * 100.).round() as usize)
            }
            _ => "—".to_owned(),
        },
        "cacheWrites" => thread.usage.cache_write_tokens.map_or_else(
            || "—".to_owned(),
            |value| token_label(usize::try_from(value).unwrap_or(usize::MAX)),
        ),
        "cost" => thread.usage.cost_micro_usd.map_or_else(
            || "—".to_owned(),
            |value| format!("{}{:0.6}", "$", value as f64 / 1_000_000.),
        ),
        "elapsed" => {
            if elapsed_ms == 0 {
                "—".to_owned()
            } else {
                format!("{}s", elapsed_ms / 1_000)
            }
        }
        "context" => token_label(total_tokens),
        "window" => capacity_tokens.map_or_else(|| "—".to_owned(), token_label),
        "free" => free_tokens.map_or_else(|| "—".to_owned(), token_label),
        "share" => share_label(
            total_tokens.saturating_mul(CONTEXT_CHARS_PER_TOKEN),
            whole_chars,
        ),
        "largest" => largest_chars.map_or_else(
            || "—".to_owned(),
            |value| token_label(value / CONTEXT_CHARS_PER_TOKEN),
        ),
        "subagents" => agents
            .iter()
            .filter(|agent| agent.parent_id.as_deref() == Some(thread.id.as_str()))
            .count()
            .to_string(),
        "subthreads" => subthreads.to_string(),
        "saved" | "added" | "pruned" | "reinjections" => "—".to_owned(),
        _ => "—".to_owned(),
    }
}

fn metric_title(id: &str, thread: &RuntimeThread) -> Option<String> {
    match id {
        "cache" => Some("Provider-reported cache read divided by cache input".to_owned()),
        "cacheWrites" => Some("Provider-reported cache write tokens".to_owned()),
        "cost" => Some("Provider-reported cost for this thread".to_owned()),
        "context" => Some(format!(
            "{} characters measured in this thread",
            thread.page.entries.len()
        )),
        _ => None,
    }
}

fn project_context_threads(
    runtime: &RuntimeState,
    parent_id: &str,
    agents: &[AgentSnapshot],
) -> Vec<ContextThreadRow> {
    let mut children = BTreeMap::<String, (String, Option<String>, bool)>::new();
    if let Some(snapshot) = runtime.snapshot.as_ref() {
        for summary in &snapshot.threads {
            if summary.parent_thread_id.as_deref() != Some(parent_id)
                || summary.kind.as_deref() == Some("subagent")
            {
                continue;
            }
            children.insert(
                summary.id.clone(),
                (
                    summary
                        .display_title
                        .clone()
                        .unwrap_or_else(|| summary.title.clone()),
                    summary.updated_at.clone(),
                    false,
                ),
            );
        }
    }
    for thread in runtime.threads.values() {
        if thread.id == parent_id {
            continue;
        }
        if let Some(summary) = summary_for(runtime, &thread.id)
            && summary.parent_thread_id.as_deref() != Some(parent_id)
        {
            continue;
        }
        if !children.contains_key(&thread.id) {
            children.insert(
                thread.id.clone(),
                (
                    thread.page.thread_title.clone(),
                    None,
                    thread.active.is_some(),
                ),
            );
        } else if thread.active.is_some()
            && let Some(value) = children.get_mut(&thread.id)
        {
            value.2 = true;
        }
    }
    children
        .into_iter()
        .map(|(id, (title, updated_at, active))| {
            let agent = agents.iter().find(|agent| agent.id == id);
            ContextThreadRow {
                id,
                title,
                status: if active || agent.is_some_and(AgentSnapshot::alive) {
                    "running".to_owned()
                } else {
                    "idle".to_owned()
                },
                age: updated_at
                    .as_deref()
                    .map_or_else(|| "—".to_owned(), relative_age),
                activity: agent.map(|agent| agent.activity.clone()),
            }
        })
        .collect()
}

fn relative_age(value: &str) -> String {
    if let Ok(seconds) = value.parse::<u64>() {
        return if seconds == 0 {
            "just now".to_owned()
        } else if seconds < 60 {
            format!("{seconds}s ago")
        } else if seconds < 3_600 {
            format!("{}m ago", seconds / 60)
        } else if seconds < 86_400 {
            format!("{}h ago", seconds / 3_600)
        } else {
            format!("{}d ago", seconds / 86_400)
        };
    }
    value.to_owned()
}

fn project_plans(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    agents: &[AgentSnapshot],
    disabled: bool,
) -> PlanRailState {
    let plans = thread
        .map(|thread| {
            thread
                .plans
                .iter()
                .map(|plan| project_plan(plan, agents))
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected_plan = plans
        .iter()
        .find(|plan| plan.steps.iter().any(|step| step.status == "running"))
        .or_else(|| plans.first())
        .map(|plan| plan.id.clone());
    let selected_step = selected_plan
        .as_deref()
        .and_then(|id| plans.iter().find(|plan| plan.id == id))
        .and_then(|plan| {
            plan.steps
                .iter()
                .find(|step| step.status == "running")
                .or_else(|| plan.steps.iter().find(|step| step.status != "done"))
        })
        .map(|step| step.id.clone());
    let (graph_nodes, graph_edges, graph_width, graph_height) = selected_plan
        .as_deref()
        .and_then(|id| plans.iter().find(|plan| plan.id == id))
        .map(plan_graph)
        .unwrap_or_default();
    PlanRailState {
        status: status_for(runtime, !plans.is_empty()),
        plans,
        selected_plan,
        selected_step,
        graph_nodes,
        graph_edges,
        graph_width,
        graph_height,
        plan_file_open: false,
        disabled,
    }
}

fn project_plan(plan: &RuntimePlan, agents: &[AgentSnapshot]) -> PlanSnapshot {
    PlanSnapshot {
        id: plan.id.clone(),
        title: plan.title.clone(),
        goal: plan.goal.clone(),
        updated_at: plan.updated_at.clone(),
        steps: plan
            .steps
            .iter()
            .map(|step| {
                let agent = agents.iter().find(|agent| {
                    agent.title == step.title
                        || agent.prompt == step.brief
                        || agent.activity == step.title
                });
                PlanStepSnapshot {
                    id: step.id.clone(),
                    title: step.title.clone(),
                    status: step.status.clone(),
                    needs: step.needs.clone(),
                    brief: step.brief.clone(),
                    tasks: Vec::new(),
                    result: step.result.clone(),
                    agent_id: agent.map(|agent| agent.id.clone()),
                    activity: agent.map(|agent| agent.activity.clone()),
                }
            })
            .collect(),
    }
}

fn plan_graph(plan: &PlanSnapshot) -> (Vec<PlanGraphNode>, Vec<PlanGraphEdge>, f32, f32) {
    let items = plan
        .steps
        .iter()
        .map(|step| (step.id.clone(), step.needs.clone()))
        .collect::<Vec<_>>();
    let rows = dependency_rows(&items);
    let layout = place_rows(&rows, GRAPH_BOX);
    let waves = rows
        .iter()
        .enumerate()
        .flat_map(|(wave, row)| row.iter().map(move |id| (id.as_str(), wave)))
        .collect::<BTreeMap<_, _>>();
    let nodes = layout
        .placed
        .into_iter()
        .map(|node| PlanGraphNode {
            wave: waves.get(node.id.as_str()).copied().unwrap_or_default(),
            id: node.id,
            x: node.x,
            y: node.y,
            width: GRAPH_BOX.width,
            height: GRAPH_BOX.height,
        })
        .collect::<Vec<_>>();
    let edges = plan
        .steps
        .iter()
        .flat_map(|step| {
            step.needs.iter().map(|need| PlanGraphEdge {
                from: need.clone(),
                to: step.id.clone(),
            })
        })
        .collect();
    (
        nodes.clone(),
        edges,
        layout_width(&nodes, GRAPH_BOX),
        layout_height(&nodes, GRAPH_BOX),
    )
}

fn dependency_rows(items: &[(String, Vec<String>)]) -> Vec<Vec<String>> {
    let mut depth = BTreeMap::<String, usize>::new();
    let mut rows = Vec::<Vec<String>>::new();
    for (index, (id, needs)) in items.iter().enumerate() {
        let wave = needs
            .iter()
            .filter_map(|need| depth.get(need).copied())
            .max()
            .map_or(0, |value| value + 1);
        let wave = if wave > index + 1 { index } else { wave };
        depth.insert(id.clone(), wave);
        while rows.len() <= wave {
            rows.push(Vec::new());
        }
        rows[wave].push(id.clone());
    }
    rows
}

fn layout_width(nodes: &[PlanGraphNode], graph_box: GraphBox) -> f32 {
    nodes
        .iter()
        .map(|node| node.x + node.width)
        .fold(graph_box.width, f32::max)
        + graph_box.lane
}

fn layout_height(nodes: &[PlanGraphNode], graph_box: GraphBox) -> f32 {
    nodes
        .iter()
        .map(|node| node.y + node.height)
        .fold(graph_box.height, f32::max)
}

fn project_tasks(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    disabled: bool,
) -> TaskListState {
    let lists = thread
        .map(|thread| {
            thread
                .tasks
                .iter()
                .map(project_task_list)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let selected_list = lists
        .iter()
        .find(|list| list.tasks.iter().any(|task| task.status == "in_progress"))
        .or_else(|| lists.first())
        .map(|list| list.id.clone());
    let selected_task = selected_list
        .as_deref()
        .and_then(|id| lists.iter().find(|list| list.id == id))
        .and_then(|list| first_task(&list.tasks, |task| task.status == "in_progress"))
        .map(|task| task.id.clone());
    let (graph_nodes, graph_edges, graph_width, graph_height) = selected_list
        .as_deref()
        .and_then(|id| lists.iter().find(|list| list.id == id))
        .map(task_graph)
        .unwrap_or_default();
    TaskListState {
        status: status_for(runtime, !lists.is_empty()),
        lists,
        selected_list,
        selected_task,
        graph_nodes,
        graph_edges,
        graph_width,
        graph_height,
        file_open: false,
        disabled,
    }
}

fn project_task_list(list: &RuntimeTaskList) -> TaskListSnapshot {
    TaskListSnapshot {
        id: list.id.clone(),
        title: list.title.clone(),
        goal: list.goal.clone(),
        tasks: nest_tasks(&list.tasks),
        updated_at: list.updated_at.clone(),
    }
}

fn nest_tasks(tasks: &[RuntimeTask]) -> Vec<TaskSnapshot> {
    fn visit(
        tasks: &[RuntimeTask],
        parent: Option<&str>,
        seen: &mut HashSet<String>,
    ) -> Vec<TaskSnapshot> {
        let mut result = Vec::new();
        for task in tasks {
            if task.parent_id.as_deref() != parent || !seen.insert(task.id.clone()) {
                continue;
            }
            result.push(TaskSnapshot {
                id: task.id.clone(),
                title: task.title.clone(),
                status: task.status.clone(),
                parent_id: task.parent_id.clone(),
                depth: task.depth,
                subtasks: visit(tasks, Some(task.id.as_str()), seen),
            });
        }
        result
    }
    let mut seen = HashSet::new();
    let mut roots = visit(tasks, None, &mut seen);
    for task in tasks {
        if !seen.contains(&task.id) {
            roots.push(TaskSnapshot {
                id: task.id.clone(),
                title: task.title.clone(),
                status: task.status.clone(),
                parent_id: task.parent_id.clone(),
                depth: task.depth,
                subtasks: Vec::new(),
            });
        }
    }
    roots
}

fn first_task<F>(tasks: &[TaskSnapshot], predicate: F) -> Option<&TaskSnapshot>
where
    F: Fn(&TaskSnapshot) -> bool + Copy,
{
    tasks.iter().find(|task| predicate(task)).or_else(|| {
        tasks
            .iter()
            .find_map(|task| first_task(&task.subtasks, predicate))
    })
}

fn task_graph(list: &TaskListSnapshot) -> (Vec<PlanGraphNode>, Vec<PlanGraphEdge>, f32, f32) {
    let mut items = Vec::<(String, Vec<String>)>::new();
    fn visit(tasks: &[TaskSnapshot], items: &mut Vec<(String, Vec<String>)>) {
        for task in tasks {
            items.push((
                task.id.clone(),
                task.parent_id.clone().into_iter().collect(),
            ));
            visit(&task.subtasks, items);
        }
    }
    visit(&list.tasks, &mut items);
    let rows = dependency_rows(&items);
    let layout = place_rows(&rows, GRAPH_BOX);
    let waves = rows
        .iter()
        .enumerate()
        .flat_map(|(wave, row)| row.iter().map(move |id| (id.as_str(), wave)))
        .collect::<BTreeMap<_, _>>();
    let nodes = layout
        .placed
        .into_iter()
        .map(|node| PlanGraphNode {
            wave: waves.get(node.id.as_str()).copied().unwrap_or_default(),
            id: node.id,
            x: node.x,
            y: node.y,
            width: GRAPH_BOX.width,
            height: GRAPH_BOX.height,
        })
        .collect::<Vec<_>>();
    let edges = items
        .iter()
        .flat_map(|(id, needs)| {
            needs.iter().map(|need| PlanGraphEdge {
                from: need.clone(),
                to: id.clone(),
            })
        })
        .collect();
    (
        nodes.clone(),
        edges,
        layout_width(&nodes, GRAPH_BOX),
        layout_height(&nodes, GRAPH_BOX),
    )
}

fn project_timeline(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    now: u64,
    disabled: bool,
) -> TimelineState {
    let turns = thread.map_or_else(Vec::new, |thread| timeline_turns(&thread.timeline));
    let carried_tokens = thread
        .map(|thread| usize::try_from(thread.usage.input_tokens).unwrap_or(usize::MAX))
        .unwrap_or_default();
    TimelineState {
        status: status_for(runtime, !turns.is_empty()),
        turns,
        axis: TimelineAxis::Time,
        collapsed: Vec::new(),
        selected: None,
        expanded: false,
        carried_tokens,
        now,
        disabled,
    }
}

fn timeline_turns(spans: &[RuntimeTimelineSpan]) -> Vec<TimelineTurn> {
    let by_id = spans
        .iter()
        .map(|span| (span.id.as_str(), span))
        .collect::<BTreeMap<_, _>>();
    let roots = spans
        .iter()
        .filter(|span| span.parent_id.is_none())
        .map(|span| span.id.clone())
        .collect::<Vec<_>>();
    if roots.is_empty() {
        return if spans.is_empty() {
            Vec::new()
        } else {
            vec![TimelineTurn {
                id: "timeline".to_owned(),
                label: "Timeline".to_owned(),
                spans: spans.iter().map(project_timeline_span).collect(),
                live: spans.iter().any(|span| span.ended_at.is_none()),
            }]
        };
    }
    roots
        .into_iter()
        .map(|root| {
            let spans = spans
                .iter()
                .filter(|span| root_id(span, &by_id).as_deref() == Some(root.as_str()))
                .map(project_timeline_span)
                .collect::<Vec<_>>();
            let label = spans
                .iter()
                .find(|span| span.id == root)
                .map(|span| span.name.clone())
                .unwrap_or_else(|| "Turn".to_owned());
            TimelineTurn {
                id: root,
                label,
                live: spans.iter().any(|span| span.ended_at.is_none()),
                spans,
            }
        })
        .collect()
}

fn root_id<'a>(
    span: &'a RuntimeTimelineSpan,
    by_id: &BTreeMap<&str, &'a RuntimeTimelineSpan>,
) -> Option<String> {
    let mut current = span;
    let mut seen = HashSet::new();
    loop {
        if !seen.insert(current.id.as_str()) {
            return Some(current.id.clone());
        }
        let Some(parent) = current.parent_id.as_deref() else {
            return Some(current.id.clone());
        };
        let Some(parent_span) = by_id.get(parent) else {
            return Some(current.id.clone());
        };
        current = parent_span;
    }
}

fn project_timeline_span(span: &RuntimeTimelineSpan) -> TimelineSpan {
    TimelineSpan {
        id: span.id.clone(),
        parent_id: span.parent_id.clone(),
        name: span.name.clone(),
        kind: span.kind.clone(),
        started_at: span.started_at,
        ended_at: span.ended_at,
        status: span.status.clone(),
        input: span.input.clone(),
        output: span.output.clone(),
        tokens: span.tokens,
    }
}

fn project_machine(runtime: &RuntimeState, _now: u64, disabled: bool) -> MachineSurfaceState {
    MachineSurfaceState {
        status: status_for(runtime, false),
        samples: Vec::new(),
        orientation: "vertical".to_owned(),
        view: MachineView::Stats,
        disabled,
    }
}

fn project_git(
    runtime: &RuntimeState,
    thread: Option<&RuntimeThread>,
    disabled: bool,
) -> GitPageState {
    let available = thread.is_some_and(|thread| thread.page.git_available);
    let panel = GitPanelState {
        status: if available {
            InspectorStatus::Loading
        } else if disabled {
            InspectorStatus::Disabled("Git data is unavailable".to_owned())
        } else {
            status_for(runtime, false)
        },
        ready: if available {
            GitReadyState::Ready
        } else {
            GitReadyState::NoRepo
        },
        snapshot: None,
        folder_id: None,
        full: false,
        filter: String::new(),
        excluded: Vec::new(),
        busy: false,
        error: None,
        disabled,
    };
    GitPageState {
        panel,
        view: crate::inspector_surfaces::GitView::Changes,
        branch_open: false,
        naming: false,
        base: String::new(),
        draft_branch: String::new(),
        message: String::new(),
        amend: false,
        commits: Vec::new(),
        more_history: false,
        command: String::new(),
        output: String::new(),
    }
}

fn project_cli(
    runtime: &RuntimeState,
    selected_thread_id: &Option<String>,
    disabled: bool,
) -> CliRunState {
    CliRunState {
        id: "cli".to_owned(),
        cli: "harness".to_owned(),
        label: "CLI".to_owned(),
        thread_id: selected_thread_id.clone().unwrap_or_default(),
        title: "CLI".to_owned(),
        cwd: String::new(),
        folder: String::new(),
        status: match runtime.status {
            crate::runtime_services::ServiceStatus::Starting => "loading".to_owned(),
            crate::runtime_services::ServiceStatus::Ready => "idle".to_owned(),
            crate::runtime_services::ServiceStatus::Restarting => "restarting".to_owned(),
            crate::runtime_services::ServiceStatus::Offline => "offline".to_owned(),
            crate::runtime_services::ServiceStatus::Degraded => "error".to_owned(),
        },
        exit_code: None,
        turns: 0,
        started_at: 0,
        turn_started_at: 0,
        ended_at: None,
        unattended: false,
        owns_session: false,
        model: None,
        output: String::new(),
        rich: false,
        message: String::new(),
        attachments: Vec::<CliAttachment>::new(),
        models: Vec::new(),
        models_at: None,
        models_busy: false,
        models_open: false,
        error: None,
        busy: false,
        disabled,
    }
}

fn project_harness(runtime: &RuntimeState, disabled: bool) -> HarnessSurfaceState {
    HarnessSurfaceState {
        status: status_for(runtime, false),
        health: if disabled {
            HarnessHealth::Offline
        } else {
            HarnessHealth::Ready
        },
        processes: Vec::new(),
        lines: Vec::new(),
        flow: HarnessFlow::All,
        open: false,
        expanded_line: None,
        copied: false,
        error: None,
        busy: false,
        disabled,
    }
}

fn json_string(value: Option<&Value>) -> Option<String> {
    value
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
}

fn json_usize(value: Option<&Value>) -> usize {
    value
        .and_then(Value::as_u64)
        .and_then(|value| usize::try_from(value).ok())
        .unwrap_or_default()
}

fn json_array_strings(value: Option<&Value>) -> Vec<String> {
    value
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| item.as_str().map(str::to_owned))
                .collect()
        })
        .unwrap_or_default()
}

fn project_goal(
    runtime: &RuntimeState,
    selected_thread_id: &Option<String>,
    thread: Option<&RuntimeThread>,
    agents: &[AgentSnapshot],
    disabled: bool,
) -> Option<GoalSurfaceState> {
    let id = selected_thread_id.as_deref()?;
    let summary = summary_for(runtime, id)?;
    let value = summary.goal.as_ref()?;
    let objective = json_string(value.get("objective"))?;
    let status = json_string(value.get("status")).unwrap_or_else(|| "active".to_owned());
    let plan = value
        .get("plan")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    Some(GoalPlanStep {
                        id: json_string(item.get("id"))?,
                        title: json_string(item.get("title")).unwrap_or_default(),
                        status: json_string(item.get("status")).unwrap_or_default(),
                        needs: json_array_strings(item.get("needs")),
                        result: json_string(item.get("result")),
                    })
                })
                .collect()
        })
        .unwrap_or_default();
    let revisions = value
        .get("revisions")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(|item| GoalRevisionSnapshot {
                    at: json_string(item.get("at")).unwrap_or_default(),
                    steps: json_usize(item.get("steps")),
                    added: json_array_strings(item.get("added")),
                    rewritten: json_array_strings(item.get("rewritten")),
                    removed: json_array_strings(item.get("removed")),
                })
                .collect()
        })
        .unwrap_or_default();
    let agents = agents
        .iter()
        .filter(|agent| agent.parent_id.as_deref() == Some(id))
        .map(|agent| GoalAgentSnapshot {
            id: agent.id.clone(),
            title: agent.title.clone(),
            color: agent.color.clone(),
            status: agent.status.clone(),
            activity: agent.activity.clone(),
        })
        .collect();
    Some(GoalSurfaceState {
        status: status_for(runtime, true),
        thread_id: id.to_owned(),
        objective: Some(objective),
        goal_status: Some(status),
        token_budget: json_usize(value.get("tokenBudget")),
        tokens_used: json_usize(value.get("tokensUsed")),
        time_used_seconds: value
            .get("timeUsedSeconds")
            .and_then(Value::as_u64)
            .unwrap_or_default(),
        turns: json_usize(value.get("turns")),
        max_turns: 40,
        created_at: json_string(value.get("createdAt")).unwrap_or_default(),
        evidence: json_string(value.get("evidence")),
        blocked_reason: json_string(value.get("blockedReason")),
        blocked_streak: json_usize(value.get("blockedStreak")),
        blocked_limit: 3,
        plan,
        revisions,
        agents,
        busy: thread.is_some_and(|thread| thread.active.is_some()),
        error: runtime_issue(runtime),
        disabled,
    })
}

fn project_empty_goal(
    runtime: &RuntimeState,
    selected_thread_id: &Option<String>,
    disabled: bool,
) -> GoalSurfaceState {
    GoalSurfaceState {
        status: if disabled {
            InspectorStatus::Disabled("Goal data is unavailable".to_owned())
        } else {
            status_for(runtime, false)
        },
        thread_id: selected_thread_id.clone().unwrap_or_default(),
        objective: None,
        goal_status: None,
        token_budget: 0,
        tokens_used: 0,
        time_used_seconds: 0,
        turns: 0,
        max_turns: 40,
        created_at: String::new(),
        evidence: None,
        blocked_reason: None,
        blocked_streak: 0,
        blocked_limit: 3,
        plan: Vec::new(),
        revisions: Vec::new(),
        agents: Vec::new(),
        busy: false,
        error: None,
        disabled,
    }
}

fn project_activity(runtime: &RuntimeState, disabled: bool) -> ActivitySurfaceState {
    let summaries = runtime
        .snapshot
        .as_ref()
        .map(|snapshot| snapshot.threads.clone())
        .unwrap_or_default();
    let live_threads = runtime
        .threads
        .values()
        .filter(|thread| thread.active.is_some())
        .count();
    let mut turns = 0;
    let mut subagents = 0;
    let mut days = BTreeMap::<String, usize>::new();
    let mut started = BTreeMap::<String, usize>::new();
    let mut project_threads = 0;
    let mut project_messages = 0;
    let mut project_last = String::new();
    let mut lineage = Vec::new();
    for summary in &summaries {
        if summary.archived_at.is_some() {
            continue;
        }
        let (thread_turns, messages, dates) = activity_data(runtime, summary);
        turns += thread_turns;
        project_threads += 1;
        project_messages += messages;
        if summary
            .updated_at
            .as_deref()
            .is_some_and(|value| value > project_last.as_str())
        {
            project_last = summary.updated_at.clone().unwrap_or_default();
        }
        if summary.kind.as_deref() == Some("subagent") {
            subagents += 1;
        }
        for day in dates {
            *days.entry(day).or_default() += 1;
        }
        if let Some(day) = summary.created_at.as_deref().and_then(activity_day) {
            *started.entry(day).or_default() += 1;
        }
        lineage.push(ActivityLineageSnapshot {
            id: summary.id.clone(),
            title: summary
                .display_title
                .clone()
                .unwrap_or_else(|| summary.title.clone()),
            meta: summary.kind.clone().unwrap_or_else(|| "thread".to_owned()),
            depth: summary_depth(summary, &summaries),
            subagent: summary.kind.as_deref() == Some("subagent"),
        });
    }
    if summaries.is_empty() {
        for thread in runtime.threads.values() {
            let message_entries = thread
                .page
                .entries
                .iter()
                .filter_map(message_entry)
                .collect::<Vec<_>>();
            let messages = message_entries.len();
            turns += message_entries
                .iter()
                .filter(|message| message.role == ConversationRole::User)
                .count();
            project_threads += 1;
            project_messages += messages;
            if thread.active.is_some() {
                subagents += thread
                    .agents
                    .values()
                    .filter(|agent| agent.parent_id.is_some())
                    .count();
            }
            lineage.push(ActivityLineageSnapshot {
                id: thread.id.clone(),
                title: thread.page.thread_title.clone(),
                meta: "thread".to_owned(),
                depth: 0,
                subagent: false,
            });
            for message in message_entries {
                if let Some(day) = activity_day(&message.timestamp) {
                    *days.entry(day).or_default() += 1;
                }
            }
        }
    }
    let projects = if project_threads == 0 {
        Vec::new()
    } else {
        vec![ActivityProjectSnapshot {
            name: "Workspace".to_owned(),
            threads: project_threads,
            messages: project_messages,
            last_at: project_last,
            days: days
                .into_iter()
                .map(|(key, count)| ActivityDaySnapshot { key, count })
                .collect(),
        }]
    };
    ActivitySurfaceState {
        status: status_for(runtime, project_threads > 0),
        live_threads,
        turns,
        subagents,
        streak: 0,
        span: ActivitySpan::Week,
        history_open: false,
        days: projects
            .first()
            .map(|project| project.days.clone())
            .unwrap_or_default(),
        started: started
            .into_iter()
            .map(|(key, count)| ActivityDaySnapshot { key, count })
            .collect(),
        projects,
        lineage,
        disabled,
    }
}

fn activity_data(
    runtime: &RuntimeState,
    summary: &HostThreadSummary,
) -> (usize, usize, Vec<String>) {
    if let Some(messages) = summary.messages.as_deref() {
        return (
            messages
                .iter()
                .filter(|message| message.role == ConversationRole::User)
                .count(),
            messages.len(),
            messages
                .iter()
                .filter_map(|message| activity_day(&message.timestamp))
                .collect(),
        );
    }
    if let Some(thread) = runtime.threads.get(&summary.id) {
        let messages = thread
            .page
            .entries
            .iter()
            .filter_map(message_entry)
            .collect::<Vec<_>>();
        return (
            messages
                .iter()
                .filter(|message| message.role == ConversationRole::User)
                .count(),
            messages.len(),
            messages
                .iter()
                .filter_map(|message| activity_day(&message.timestamp))
                .collect(),
        );
    }
    (summary.message_count, summary.message_count, Vec::new())
}

fn activity_day(value: &str) -> Option<String> {
    let value = value.trim();
    let candidate = value.get(..10)?;
    let bytes = candidate.as_bytes();
    if bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes[..4].iter().all(u8::is_ascii_digit)
        && bytes[5..7].iter().all(u8::is_ascii_digit)
        && bytes[8..].iter().all(u8::is_ascii_digit)
    {
        Some(candidate.to_owned())
    } else {
        None
    }
}

fn summary_depth(summary: &HostThreadSummary, summaries: &[HostThreadSummary]) -> usize {
    let mut parent = summary.parent_thread_id.as_deref();
    let mut depth = 0;
    let mut seen = HashSet::new();
    while let Some(id) = parent {
        if !seen.insert(id) {
            break;
        }
        depth += 1;
        parent = summaries
            .iter()
            .find(|summary| summary.id == id)
            .and_then(|summary| summary.parent_thread_id.as_deref());
    }
    depth
}

fn project_model_plans(runtime: &RuntimeState, disabled: bool) -> ModelPlansState {
    ModelPlansState {
        status: if disabled {
            InspectorStatus::Disabled("Model plan credentials are not hydrated".to_owned())
        } else {
            status_for(runtime, false)
        },
        plans: Vec::<ModelPlanSnapshot>::new(),
        error: Some("Model plan credentials are owned by the host and are not hydrated".to_owned()),
        notice: None,
        busy: false,
        disabled,
    }
}

pub fn route_action(
    action: InspectorAction,
    context: &InspectorActionContext,
) -> InspectorRuntimeIntent {
    match action {
        InspectorAction::AllowPermission { id, allowed } => {
            if !allowed {
                return InspectorRuntimeIntent::Runtime(RuntimeCommand::AnswerPermission {
                    request_id: id,
                    option_id: None,
                });
            }
            match context.permission_options.get(&id).cloned() {
                Some(option_id) => {
                    InspectorRuntimeIntent::Runtime(RuntimeCommand::AnswerPermission {
                        request_id: id,
                        option_id: Some(option_id),
                    })
                }
                None => InspectorRuntimeIntent::Unavailable {
                    capability: "permission".to_owned(),
                    message: "No allow option is available for this request".to_owned(),
                },
            }
        }
        InspectorAction::StopAgent(id)
        | InspectorAction::StopThread(id)
        | InspectorAction::StopSubthread(id) => {
            InspectorRuntimeIntent::Runtime(RuntimeCommand::Stop { thread_id: id })
        }
        InspectorAction::SendThread { thread_id, text } => {
            let Some(mut submission) = context.submission.clone() else {
                return InspectorRuntimeIntent::Unavailable {
                    capability: "thread message".to_owned(),
                    message: "A composer submission is required to send this thread a message"
                        .to_owned(),
                };
            };
            let text = text.trim();
            if text.is_empty() {
                return InspectorRuntimeIntent::Unavailable {
                    capability: "thread message".to_owned(),
                    message: "A thread message cannot be empty".to_owned(),
                };
            }
            submission.text = text.to_owned();
            InspectorRuntimeIntent::Runtime(RuntimeCommand::Queue {
                thread_id,
                timestamp: if context.timestamp.is_empty() {
                    "0".to_owned()
                } else {
                    context.timestamp.clone()
                },
                submission,
            })
        }
        InspectorAction::ClearGoal(thread_id) => {
            InspectorRuntimeIntent::Host(HostCommand::ClearGoal { thread_id })
        }
        InspectorAction::PauseGoal(thread_id) => {
            InspectorRuntimeIntent::Host(HostCommand::UpdateGoal {
                thread_id,
                status: Some("paused".to_owned()),
                evidence: None,
                reason: None,
                extra_tokens: None,
            })
        }
        InspectorAction::ResumeGoal(thread_id) | InspectorAction::ContinueGoal(thread_id) => {
            InspectorRuntimeIntent::Host(HostCommand::UpdateGoal {
                thread_id,
                status: Some("active".to_owned()),
                evidence: None,
                reason: None,
                extra_tokens: None,
            })
        }
        InspectorAction::RestartHarness => InspectorRuntimeIntent::Runtime(RuntimeCommand::Restart),
        other => InspectorRuntimeIntent::Ui(other),
    }
}

pub fn permission_option_context(runtime: &RuntimeState) -> BTreeMap<String, String> {
    runtime
        .permissions
        .values()
        .filter_map(|request| {
            request
                .options
                .first()
                .map(|option| (request.id.clone(), option.id.clone()))
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::runtime_services::{
        RuntimeAcpEvent, RuntimePermissionOption, RuntimePermissionRequest, RuntimePlanStep,
        RuntimeTask, RuntimeTimelineSpan, ServiceStatus,
    };

    fn submission(text: &str) -> ComposerSubmission {
        ComposerSubmission {
            text: text.to_owned(),
            mode: PermissionMode::AcceptEdits,
            model: "model/test".to_owned(),
            source: Some("workspace".to_owned()),
            capability: Some("files".to_owned()),
            attachments: vec!["file-1".to_owned()],
        }
    }

    fn service_with_thread() -> RuntimeService {
        let mut service = RuntimeService::new();
        service
            .dispatch(RuntimeCommand::Submit {
                thread_id: "thread-1".to_owned(),
                timestamp: "2026-08-31T12:00:00Z".to_owned(),
                started_at: 1_000,
                submission: submission("ship the native inspector"),
            })
            .expect("submit");
        service.state.status = ServiceStatus::Ready;
        service.state.selected_thread = Some("thread-1".to_owned());
        service
    }

    #[test]
    fn projection_contains_every_inspector_surface_and_runtime_rows() {
        let mut service = service_with_thread();
        let thread = service.state.threads.get_mut("thread-1").expect("thread");
        thread.usage = RuntimeUsage {
            input_tokens: 1_000,
            output_tokens: 400,
            cache_input_tokens: Some(800),
            cache_read_tokens: Some(200),
            cache_write_tokens: Some(100),
            cost_micro_usd: Some(1_500),
        };
        thread.context.system_prompt_bytes = 800;
        thread.context.system_tools_bytes = 400;
        thread.plans.push(RuntimePlan {
            id: "plan-1".to_owned(),
            title: "Ship".to_owned(),
            goal: "Ship the inspector".to_owned(),
            updated_at: "2026-08-31T12:00:00Z".to_owned(),
            steps: vec![
                RuntimePlanStep {
                    id: "step-1".to_owned(),
                    title: "Implement".to_owned(),
                    status: "done".to_owned(),
                    needs: Vec::new(),
                    brief: "Implement".to_owned(),
                    result: Some("done".to_owned()),
                },
                RuntimePlanStep {
                    id: "step-2".to_owned(),
                    title: "Verify".to_owned(),
                    status: "todo".to_owned(),
                    needs: vec!["step-1".to_owned()],
                    brief: "Verify".to_owned(),
                    result: None,
                },
            ],
        });
        thread.tasks.push(RuntimeTaskList {
            id: "tasks-1".to_owned(),
            title: "Checks".to_owned(),
            goal: "Keep it green".to_owned(),
            updated_at: "2026-08-31T12:00:00Z".to_owned(),
            tasks: vec![
                RuntimeTask {
                    id: "task-1".to_owned(),
                    title: "Build".to_owned(),
                    status: "completed".to_owned(),
                    parent_id: None,
                    depth: 0,
                },
                RuntimeTask {
                    id: "task-2".to_owned(),
                    title: "Test".to_owned(),
                    status: "in_progress".to_owned(),
                    parent_id: Some("task-1".to_owned()),
                    depth: 1,
                },
            ],
        });
        thread.timeline.push(RuntimeTimelineSpan {
            id: "turn-1".to_owned(),
            parent_id: None,
            name: "Turn 1".to_owned(),
            kind: "agent".to_owned(),
            started_at: 1,
            ended_at: Some(2),
            status: "ok".to_owned(),
            input: None,
            output: None,
            tokens: Some(100),
        });
        let output = service
            .accept_acp(RuntimeAcpEvent::Subagent(RuntimeAgentUpdate {
                id: "agent-1".to_owned(),
                parent_id: Some("thread-1".to_owned()),
                title: "Verifier".to_owned(),
                brief: "Verify".to_owned(),
                color: None,
                status: NestedAgentStatus::Running,
                model: Some("model/test".to_owned()),
                effort: None,
                activity: Some("running checks".to_owned()),
                prompt: Some("Verify".to_owned()),
                tool: false,
                started_at: 1,
                ended_at: None,
                steps: 1,
                tool_calls: 0,
                input_tokens: 10,
                output_tokens: 20,
                generation_ms: 100,
                error: None,
            }))
            .expect("agent event");
        assert_eq!(output.events.len(), 1);
        let projection = project_service(
            &service,
            &InspectorRuntimeInput {
                selected_context_page: Some("p2".to_owned()),
                context_capacity_tokens: Some(2_000),
                now: 3_000,
                ..InspectorRuntimeInput::default()
            },
        );
        assert_eq!(projection.selected_thread_id.as_deref(), Some("thread-1"));
        assert_eq!(projection.context.page_name, "Run");
        assert!(
            projection
                .context
                .rows
                .iter()
                .any(|row| row.kind == "messages")
        );
        assert_eq!(projection.plan.plans.len(), 1);
        assert_eq!(projection.plan.graph_edges.len(), 1);
        assert_eq!(projection.tasks.lists[0].tasks[0].subtasks[0].id, "task-2");
        assert_eq!(projection.timeline.turns.len(), 1);
        assert_eq!(projection.context.agents[0].id, "agent-1");
        assert_eq!(projection.surfaces.len(), 22);
        for id in [
            "mode",
            "permission",
            "agent-rail",
            "background-rail",
            "tabs",
            "agent-panel",
            "thread-card",
            "subagent-chips",
            "changes",
            "context",
            "context-settings",
            "plan",
            "tasks",
            "timeline",
            "machine",
            "git",
            "git-page",
            "cli",
            "harness",
            "goal",
            "activity",
            "model-plans",
        ] {
            assert!(projection.surface(id).is_some(), "missing {id}");
        }
    }

    #[test]
    fn permission_route_is_fail_closed_and_preserves_submission_fields() {
        let mut context = InspectorActionContext {
            thread_id: Some("thread-1".to_owned()),
            timestamp: "2026-08-31T12:00:00Z".to_owned(),
            started_at: 22,
            submission: Some(submission("original")),
            ..InspectorActionContext::default()
        };
        context
            .permission_options
            .insert("permission-1".to_owned(), "allow-once".to_owned());
        assert_eq!(
            route_action(
                InspectorAction::AllowPermission {
                    id: "permission-1".to_owned(),
                    allowed: true,
                },
                &context,
            ),
            InspectorRuntimeIntent::Runtime(RuntimeCommand::AnswerPermission {
                request_id: "permission-1".to_owned(),
                option_id: Some("allow-once".to_owned()),
            })
        );
        assert!(matches!(
            route_action(
                InspectorAction::AllowPermission {
                    id: "missing".to_owned(),
                    allowed: true,
                },
                &context,
            ),
            InspectorRuntimeIntent::Unavailable { .. }
        ));
        let intent = route_action(
            InspectorAction::SendThread {
                thread_id: "thread-2".to_owned(),
                text: " follow up ".to_owned(),
            },
            &context,
        );
        assert_eq!(
            intent,
            InspectorRuntimeIntent::Runtime(RuntimeCommand::Queue {
                thread_id: "thread-2".to_owned(),
                timestamp: "2026-08-31T12:00:00Z".to_owned(),
                submission: ComposerSubmission {
                    text: "follow up".to_owned(),
                    mode: PermissionMode::AcceptEdits,
                    model: "model/test".to_owned(),
                    source: Some("workspace".to_owned()),
                    capability: Some("files".to_owned()),
                    attachments: vec!["file-1".to_owned()],
                },
            })
        );
    }

    #[test]
    fn offline_projection_disables_native_actions_without_erasing_data() {
        let mut service = service_with_thread();
        service.state.status = ServiceStatus::Offline;
        let projection = project_service(&service, &InspectorRuntimeInput::default());
        assert!(projection.mode.disabled);
        assert!(projection.permission.disabled);
        assert!(projection.context.disabled);
        assert!(projection.context.status.is_disabled());
        assert!(projection.model_plans.status.is_disabled());
    }

    #[test]
    fn context_projection_uses_the_selected_stats_widget_metrics() {
        let service = service_with_thread();
        let projection = project_service(
            &service,
            &InspectorRuntimeInput {
                context_pages: vec![ContextPageSource {
                    id: "custom".to_owned(),
                    name: "Custom".to_owned(),
                    widgets: vec![ContextWidgetSnapshot {
                        id: "stats".to_owned(),
                        label: "Thread stats".to_owned(),
                        glyph: "▦".to_owned(),
                        orientation: "horizontal".to_owned(),
                        metrics: vec!["subthreads".to_owned(), "elapsed".to_owned()],
                    }],
                }],
                selected_context_page: Some("custom".to_owned()),
                ..InspectorRuntimeInput::default()
            },
        );
        assert_eq!(
            projection
                .context
                .metrics
                .iter()
                .map(|metric| metric.id.as_str())
                .collect::<Vec<_>>(),
            ["subthreads", "elapsed"]
        );
    }

    #[test]
    fn direct_surface_inputs_inherit_runtime_disabled_state() {
        let service = service_with_thread();
        let projection = project_service(
            &service,
            &InspectorRuntimeInput {
                disabled: true,
                machine: Some(MachineSurfaceState {
                    status: InspectorStatus::Ready,
                    samples: Vec::new(),
                    orientation: "vertical".to_owned(),
                    view: MachineView::Stats,
                    disabled: false,
                }),
                ..InspectorRuntimeInput::default()
            },
        );
        assert!(projection.machine.disabled);
        assert!(projection.machine.status.is_disabled());
    }

    #[test]
    fn permission_option_context_uses_the_first_provider_option() {
        let mut service = service_with_thread();
        service.state.permissions.insert(
            "permission-1".to_owned(),
            RuntimePermissionRequest {
                id: "permission-1".to_owned(),
                thread_id: "thread-1".to_owned(),
                session_id: None,
                mode: PermissionMode::Ask,
                title: "Allow".to_owned(),
                tool: "shell".to_owned(),
                detail: "run".to_owned(),
                options: vec![RuntimePermissionOption {
                    id: "allow".to_owned(),
                    name: "Allow once".to_owned(),
                    kind: "allow_once".to_owned(),
                }],
            },
        );
        let options = permission_option_context(&service.state);
        assert_eq!(
            options.get("permission-1").map(String::as_str),
            Some("allow")
        );
    }

    #[test]
    fn activity_day_only_accepts_iso_calendar_prefixes() {
        assert_eq!(
            activity_day("2026-08-31T12:00:00Z").as_deref(),
            Some("2026-08-31")
        );
        assert_eq!(activity_day("not-a-date"), None);
        assert_eq!(activity_day("2026/08/31"), None);
    }
}

fn metric_label(id: &str) -> &'static str {
    match id {
        "messages" => "Messages",
        "replies" => "Emma replies",
        "attachments" => "Attachments",
        "calls" => "Tool calls",
        "rate" => "Avg tok/s",
        "output" => "Output tokens",
        "cache" => "Cache hit rate",
        "cacheWrites" => "Cache writes",
        "cost" => "Cost/task",
        "elapsed" => "Generation time",
        "context" => "Context carried",
        "window" => "Context window",
        "free" => "Context free",
        "share" => "Context used",
        "largest" => "Largest segment",
        "subagents" => "Subagents",
        "subthreads" => "Sub threads",
        "saved" => "Pruning saved",
        "added" => "Pruning added",
        "pruned" => "Pruned results",
        "reinjections" => "Reinjections",
        _ => "Metric",
    }
}
