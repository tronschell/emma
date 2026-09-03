mod acp;
mod host;

use std::{
    borrow::Cow,
    collections::{HashMap, HashSet},
    env,
    process::Command,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use gpui::{
    AppContext as _, AssetSource, ClipboardItem, Context, Div, Entity, FocusHandle, Focusable as _,
    IntoElement, ParentElement as _, Render, RenderOnce as _, SharedString, Styled as _,
    Subscription, Task, Window, div, px,
};
use gpui_component::{
    ActiveTheme as _, Root, StyledExt as _,
    button::{Button, ButtonVariants as _},
    input::{InputEvent, InputState, TextareaState},
    v_flex,
};
use rust_embed::RustEmbed;
use serde::Deserialize;
use serde_json::{Value, json};

use crate::acp::{AcpClient, AcpEvent, AcpPermissionOption};
use crate::host::{HostClient, HostEvent};
use emma_app::{
    browser_pane::{
        BrowserPaneAction, BrowserPaneEffect, BrowserPaneKind, BrowserPaneState, BrowserPaneView,
        ComponentPaneEffect, VisualPaneEffect,
    },
    browser_surface::{
        BridgeCapability, BridgeReply, BrowserCommand, BrowserError, BrowserEvent, BrowserSurface,
        Navigation, SecurityError, parse_frame_bridge_message,
    },
    conversation::{
        self, CompletionItem, CompletionKind, CompletionMenu, CompletionSigil, ComposerAction,
        ComposerState, ComposerSubmission, ConversationAction, ConversationCallbacks,
        ConversationEntry, ConversationLoadState, ConversationMessage, ConversationPage,
        ConversationRole, GenerationMeta, ModelChoice, PermissionMode, QueuedTurn, RunState,
        SourceOption, ThinkingBlock,
    },
    inspector_runtime::{
        permission_option_context, project_service, route_action, InspectorActionContext,
        InspectorRuntimeInput, InspectorRuntimeIntent, InspectorRuntimeProjection,
    },
    inspector_surfaces::{
        render_inspector_surface, InspectorAction, InspectorCallbacks, InspectorInputs,
    },
    macos_window_adapter::NativeWindowAdapter,
    native_windows::{
        NativeHostPlatform, NativeWindowController, NativeWindowRole, NativeWindowSpec,
    },
    navigation::WorkspaceMode,
    pane_layout::PaneLayout,
    runtime_services::{
        HostCommand, RuntimeAcpEvent, RuntimeAgentUpdate, RuntimeCommand, RuntimeContext,
        RuntimeEffect, RuntimeEvent, RuntimePermissionOption, RuntimePermissionRequest,
        RuntimePlan, RuntimePlanStep, RuntimeService, RuntimeTask, RuntimeTaskList,
        RuntimeTimelineSpan, RuntimeToolCall, RuntimeUsage,
    },
    settings_pages::{
        self, InputId, SettingsAction, SettingsInputs, SettingsPageId, SettingsPages,
        SettingsState, SetupAction, SetupState, SetupStep,
    },
    shell::{
        InspectorTab, ShellAction, ShellPane, ShellProject, ShellRow, ShellStatus, WorkspaceShell,
    },
    terminal_surface::{ChannelTerminalTransport, TerminalError, TerminalOpen, TerminalSurface},
    terminal_worker::TerminalWorker,
    theme::EmmaTheme,
    workspace_pages::{
        AgentPage, ArchivePage, ArtifactsPage, KnowledgePage, KnowledgeState, PageStatus,
        PluginsPage, ResearchField, ResearchForm, ResearchIteration, ResearchJob, ResearchMetric,
        ResearchPage, ScheduledDraft, ScheduledEditor, ScheduledField, ScheduledGraph,
        ScheduledGraphEdge, ScheduledJob, ScheduledPage, ScheduledStep, WorkspaceAction,
        WorkspacePage, WorkspacePageCallbacks, WorkspacePageInputs,
    },
};

const MAX_RECORDED_TURN_BYTES: usize = 120 * 1024;
const MIN_RECORDED_TURN_ROOM: usize = 512;

#[derive(RustEmbed)]
#[folder = "../../desktop/assets"]
struct Assets;

impl AssetSource for Assets {
    fn load(&self, path: &str) -> gpui::Result<Option<Cow<'static, [u8]>>> {
        let path = path.strip_prefix("desktop/assets/").unwrap_or(path);
        if path.is_empty() {
            return Ok(None);
        }
        match Self::get(path) {
            Some(asset) => Ok(Some(asset.data)),
            None => gpui_component_assets::Assets.load(path),
        }
    }

    fn list(&self, path: &str) -> gpui::Result<Vec<SharedString>> {
        let prefix = path.strip_prefix("desktop/assets/").unwrap_or(path);
        let mut assets = gpui_component_assets::Assets.list(prefix)?;
        assets.extend(
            Self::iter()
                .filter(|asset| asset.starts_with(prefix))
                .map(|asset| {
                    if path.starts_with("desktop/assets/") {
                        format!("desktop/assets/{asset}").into()
                    } else {
                        asset.into()
                    }
                })
                .collect::<Vec<_>>(),
        );
        Ok(assets)
    }
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadSummary {
    id: String,
    title: String,
    #[serde(default)]
    archived_at: Option<String>,
    #[serde(default)]
    display_title: Option<String>,
    #[serde(default)]
    messages: usize,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadData {
    id: String,
    title: String,
    #[serde(default)]
    messages: Vec<ThreadMessage>,
}

#[derive(Clone, Debug, Deserialize)]
struct ThreadMessage {
    role: String,
    content: String,
    #[serde(default)]
    generation: Option<ThreadGeneration>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ThreadGeneration {
    #[serde(default)]
    model: String,
}

#[derive(Clone, Debug)]
enum LoadState {
    Loading,
    Ready,
    Empty,
    Failed(String),
}

#[derive(Clone, Debug)]
enum RequestKind {
    Snapshot,
    ThreadSummaries,
    Thread(String),
    CreateThread,
    RecordTurn(String),
    WorkspaceMutation { label: String, refresh: bool },
    RuntimeHost {
        operation_id: String,
        method: String,
        thread_id: Option<String>,
    },
}

struct StreamingTurn {
    thread_id: String,
    prompt: String,
    response: String,
    thought: String,
    started_at: Instant,
    model: Option<String>,
}

struct PermissionPrompt {
    thread_id: Option<String>,
    session_id: Option<String>,
    permission_mode: Option<String>,
    request_id: String,
    title: String,
    options: Vec<AcpPermissionOption>,
}

struct BrowserSession {
    surface: Entity<BrowserSurface>,
    pane: BrowserPaneState,
}

struct Workspace {
    host: HostClient,
    acp: AcpClient,
    runtime: RuntimeService,
    inspector_input: InspectorRuntimeInput,
    inspector_inputs: InspectorInputs,
    inspector_actions: async_channel::Sender<InspectorAction>,
    runtime_completed: HashSet<String>,
    inspector_mode_menu_open: bool,
    inspector_context_page: Option<String>,
    inspector_context_curve_open: bool,
    inspector_context_ledger_expanded: bool,
    inspector_context_show_all: bool,
    inspector_context_agents_open: bool,
    inspector_plan: Option<String>,
    inspector_step: Option<String>,
    inspector_task_list: Option<String>,
    inspector_task: Option<String>,
    inspector_timeline_span: Option<String>,
    inspector_timeline_collapsed: Vec<String>,
    inspector_timeline_open: bool,
    inspector_git_open: bool,
    mode: WorkspaceMode,
    sidebar_collapsed: bool,
    nav_icons: bool,
    nav_more: bool,
    permission_mode: String,
    configured_model: Option<String>,
    selected_model: Option<String>,
    selected_source: Option<String>,
    mode_menu_open: bool,
    models_menu_open: bool,
    sources_open: bool,
    capabilities_open: bool,
    stop_confirmation: bool,
    state: LoadState,
    summaries: Vec<ThreadSummary>,
    archived_summaries: Vec<ThreadSummary>,
    selected_id: Option<String>,
    selected_thread: Option<ThreadData>,
    pending: HashMap<String, RequestKind>,
    streaming: Option<StreamingTurn>,
    permission: Option<PermissionPrompt>,
    notice: Option<String>,
    composer: Entity<TextareaState>,
    search: Entity<InputState>,
    rename_input: Entity<InputState>,
    thread_name: Entity<InputState>,
    renaming_thread: Option<String>,
    rename_input_sync: Option<String>,
    thread_name_sync: Option<String>,
    settings_state: SettingsState,
    settings_setup: SetupState,
    settings_inputs: SettingsInputs,
    settings_focus: FocusHandle,
    workspace_inputs: WorkspacePageInputs,
    conversation_actions: async_channel::Sender<ConversationAction>,
    workspace_actions: async_channel::Sender<WorkspaceAction>,
    queued_turns: Vec<QueuedTurn>,
    held_turns: Vec<QueuedTurn>,
    queued_submissions: HashMap<String, ComposerSubmission>,
    held_submissions: HashMap<String, ComposerSubmission>,
    next_queue_id: u64,
    expanded_thinking: Vec<String>,
    expanded_tools: Vec<String>,
    expanded_steps: Vec<String>,
    transcript_at_end: bool,
    clear_composer: bool,
    composer_replacement: Option<String>,
    composer_composing: bool,
    completion_dismissed: bool,
    completion_active: usize,
    history_index: isize,
    history_draft: String,
    scheduled_input_sync: Option<ScheduledDraft>,
    research_input_sync: Option<ResearchForm>,
    pane_layout: PaneLayout,
    inspector_before_browser: Option<bool>,
    resize_pane: Option<ShellPane>,
    terminal: Entity<TerminalSurface>,
    browser_sessions: HashMap<String, BrowserSession>,
    browser_clip_history: Vec<String>,
    browser_input: Entity<InputState>,
    browser_address_sync: Option<String>,
    inspector_tab: InspectorTab,
    settings_page: String,
    knowledge_page: KnowledgePage,
    artifacts_page: ArtifactsPage,
    scheduled_page: ScheduledPage,
    scheduled_records: HashMap<String, Value>,
    agent_page: AgentPage,
    plugins_page: PluginsPage,
    research_page: ResearchPage,
    archive_page: ArchivePage,
    _subscriptions: Vec<Subscription>,
    _event_task: Task<()>,
    _acp_event_task: Task<()>,
    _conversation_action_task: Task<()>,
    _workspace_action_task: Task<()>,
    _inspector_action_task: Task<()>,
    _terminal_worker: std::thread::JoinHandle<Result<(), TerminalError>>,
    _terminal_poll_task: Task<()>,
    _browser_poll_task: Task<()>,
}

impl Workspace {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let host = HostClient::new();
        let acp = AcpClient::new();
        let mut runtime = RuntimeService::new();
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search"));
        let browser_input =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search or enter address"));
        let rename_input = cx.new(|cx| InputState::new(window, cx).placeholder("Thread name"));
        let thread_name = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value("New thread")
                .placeholder("Thread name")
        });
        let composer = cx.new(|cx| {
            TextareaState::new(window, cx)
                .submit_on_enter(true)
                .placeholder("Message Emma")
        });
        let configured_model = configured_model();
        let configured_permission = configured_permission_mode();
        let settings_state = default_settings_state(
            configured_model.as_deref().unwrap_or_default(),
            &configured_permission,
        );
        let settings_setup = default_setup_state(configured_model.as_deref());
        let settings_focus = cx.focus_handle();
        let (settings_inputs, settings_single, settings_multiline) =
            build_settings_inputs(window, cx);
        let artifact_query =
            cx.new(|cx| InputState::new(window, cx).placeholder("Search artifacts"));
        let plugins_query = cx.new(|cx| InputState::new(window, cx).placeholder("Search plugins"));
        let scheduled_title =
            cx.new(|cx| InputState::new(window, cx).placeholder("Weekly reading sweep"));
        let scheduled_model =
            cx.new(|cx| InputState::new(window, cx).placeholder("Choose a model"));
        let scheduled_trigger = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value("manual")
                .placeholder("When should it run?")
        });
        let scheduled_prompt = cx.new(|cx| {
            TextareaState::new(window, cx).placeholder("What should Emma do on each run?")
        });
        let scheduled_runs_as = cx.new(|cx| {
            InputState::new(window, cx)
                .default_value("ask")
                .placeholder("Choose a permission mode")
        });
        let research_title =
            cx.new(|cx| InputState::new(window, cx).placeholder("Morning research sweep"));
        let research_optimizing = cx.new(|cx| {
            TextareaState::new(window, cx).placeholder("Describe the result you want to improve")
        });
        let workspace_inputs = WorkspacePageInputs {
            artifact_query: Some(artifact_query.clone()),
            scheduled: emma_app::workspace_pages::ScheduledInputs {
                title: Some(scheduled_title.clone()),
                model: Some(scheduled_model.clone()),
                trigger: Some(scheduled_trigger.clone()),
                prompt: Some(scheduled_prompt.clone()),
                runs_as: Some(scheduled_runs_as.clone()),
            },
            plugins_query: Some(plugins_query.clone()),
            research: emma_app::workspace_pages::ResearchInputs {
                title: Some(research_title.clone()),
                optimizing: Some(research_optimizing.clone()),
            },
        };
        let agent_steer = cx.new(|cx| {
            TextareaState::new(window, cx).placeholder("Send a steer to this agent")
        });
        let thread_message = cx.new(|cx| {
            InputState::new(window, cx).placeholder("Send a message to this thread")
        });
        let context_page_name =
            cx.new(|cx| InputState::new(window, cx).placeholder("Context page name"));
        let git_filter = cx.new(|cx| InputState::new(window, cx).placeholder("Filter files"));
        let git_branch = cx.new(|cx| InputState::new(window, cx).placeholder("New branch"));
        let git_message =
            cx.new(|cx| TextareaState::new(window, cx).placeholder("Commit message"));
        let git_command = cx.new(|cx| InputState::new(window, cx).placeholder("git status"));
        let cli_message =
            cx.new(|cx| TextareaState::new(window, cx).placeholder("Send to CLI"));
        let mode_search = cx.new(|cx| InputState::new(window, cx).placeholder("Search modes"));
        let model_key = cx.new(|cx| InputState::new(window, cx).placeholder("Provider key"));
        let inspector_inputs = InspectorInputs {
            agent_steer: Some(agent_steer.clone()),
            thread_message: Some(thread_message.clone()),
            context_page_name: Some(context_page_name.clone()),
            git_filter: Some(git_filter.clone()),
            git_branch: Some(git_branch.clone()),
            git_message: Some(git_message.clone()),
            git_command: Some(git_command.clone()),
            cli_message: Some(cli_message.clone()),
            mode_search: Some(mode_search.clone()),
            model_key: Some(model_key.clone()),
        };
        let (conversation_actions, conversation_receiver) = async_channel::unbounded();
        let (workspace_actions, workspace_receiver) = async_channel::unbounded();
        let (inspector_actions, inspector_receiver) = async_channel::unbounded();
        let conversation_action_task = cx.spawn(async move |this, cx| {
            while let Ok(action) = conversation_receiver.recv().await {
                if this
                    .update(cx, |this, cx| this.handle_conversation_action(action, cx))
                    .is_err()
                {
                    break;
                }
                cx.refresh();
            }
        });
        let workspace_action_task = cx.spawn(async move |this, cx| {
            while let Ok(action) = workspace_receiver.recv().await {
                if this
                    .update(cx, |this, cx| this.handle_workspace_action(action, cx))
                    .is_err()
                {
                    break;
                }
                cx.refresh();
            }
        });
        let inspector_action_task = cx.spawn(async move |this, cx| {
            while let Ok(action) = inspector_receiver.recv().await {
                if this
                    .update(cx, |this, cx| this.handle_inspector_action(action, cx))
                    .is_err()
                {
                    break;
                }
                cx.refresh();
            }
        });
        let mut subscriptions = vec![
            cx.subscribe_in(&search, window, |this, _, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    cx.notify();
                }
                let _ = this;
            }),
            cx.subscribe_in(
                &composer,
                window,
                |this, _, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::PressEnter { shift: false, .. }) {
                        this.submit(window, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &browser_input,
                window,
                |this, state, event: &InputEvent, window, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.handle_browser_action(
                            BrowserPaneAction::SetAddress(state.read(cx).value().to_string()),
                            window,
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &rename_input,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(
                        event,
                        InputEvent::Blur | InputEvent::PressEnter { shift: false, .. }
                    ) {
                        let title = state.read(cx).value().to_string();
                        this.commit_thread_rename(title, cx);
                    }
                },
            ),
            cx.subscribe_in(
                &thread_name,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(
                        event,
                        InputEvent::Blur | InputEvent::PressEnter { shift: false, .. }
                    ) {
                        this.commit_selected_thread_name(state.read(cx).value().to_string(), cx);
                    }
                },
            ),
        ];
        subscriptions.extend([
            cx.subscribe_in(
                &agent_steer,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &thread_message,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &context_page_name,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &git_filter,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &git_branch,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &git_message,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &git_command,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &cli_message,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &mode_search,
                window,
                |_this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        let _ = state.read(cx).value();
                        cx.notify();
                    }
                },
            ),
            cx.subscribe_in(
                &model_key,
                window,
                |_this, _state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        cx.notify();
                    }
                },
            ),
        ]);
        subscriptions.extend(settings_single.into_iter().map(|(id, entity)| {
            cx.subscribe_in(
                &entity,
                window,
                move |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.handle_settings_input(id, state.read(cx).value().to_string(), cx);
                    }
                },
            )
        }));
        subscriptions.extend(settings_multiline.into_iter().map(|(id, entity)| {
            cx.subscribe_in(
                &entity,
                window,
                move |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.handle_settings_input(id, state.read(cx).value().to_string(), cx);
                    }
                },
            )
        }));
        subscriptions.push(cx.subscribe_in(
            &artifact_query,
            window,
            |this, state, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.artifacts_page.query = state.read(cx).value().to_string();
                    cx.notify();
                }
            },
        ));
        subscriptions.push(cx.subscribe_in(
            &plugins_query,
            window,
            |this, state, event: &InputEvent, _, cx| {
                if matches!(event, InputEvent::Change) {
                    this.plugins_page.query = state.read(cx).value().to_string();
                    cx.notify();
                }
            },
        ));
        subscriptions.extend([
            cx.subscribe_in(
                &scheduled_title,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_scheduled_field(
                            ScheduledField::Title,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &scheduled_model,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_scheduled_field(
                            ScheduledField::Model,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &scheduled_trigger,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_scheduled_field(
                            ScheduledField::Trigger,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &scheduled_prompt,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_scheduled_field(
                            ScheduledField::Prompt,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &scheduled_runs_as,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_scheduled_field(
                            ScheduledField::RunsAs,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &research_title,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_research_field(
                            ResearchField::Title,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
            cx.subscribe_in(
                &research_optimizing,
                window,
                |this, state, event: &InputEvent, _, cx| {
                    if matches!(event, InputEvent::Change) {
                        this.update_research_field(
                            ResearchField::Optimizing,
                            state.read(cx).value().to_string(),
                            cx,
                        );
                    }
                },
            ),
        ]);
        let mut pending = HashMap::new();
        let state = match host.request("threadSummaries", Value::Null) {
            Ok(id) => {
                pending.insert(id, RequestKind::ThreadSummaries);
                LoadState::Loading
            }
            Err(error) => LoadState::Failed(error),
        };
        if let Ok(output) = runtime.dispatch(RuntimeCommand::HydrateSnapshot) {
            for effect in output.effects {
                if let RuntimeEffect::HostRequest {
                    operation_id,
                    method,
                    params,
                } = effect
                {
                    match host.request(&method, params) {
                        Ok(id) => {
                            pending.insert(
                                id,
                                RequestKind::RuntimeHost {
                                    operation_id,
                                    method,
                                    thread_id: None,
                                },
                            );
                        }
                        Err(error) => {
                            let _ = runtime.accept_host_response(operation_id, Err(error));
                        }
                    }
                }
            }
        }
        let events = host.events();
        let event_task = cx.spawn(async move |this, cx| {
            while let Ok(event) = events.recv().await {
                if this
                    .update(cx, |this, cx| this.handle_event(event, cx))
                    .is_err()
                {
                    break;
                }
                cx.refresh();
            }
        });
        let acp_events = acp.events();
        let acp_event_task = cx.spawn(async move |this, cx| {
            while let Ok(event) = acp_events.recv().await {
                if this
                    .update(cx, |this, cx| this.handle_acp_event(event, cx))
                    .is_err()
                {
                    break;
                }
                cx.refresh();
            }
        });
        let (terminal_transport, terminal_port) =
            ChannelTerminalTransport::channel(64).expect("terminal channel capacity is valid");
        let terminal_worker = TerminalWorker::start_with_default_helper(terminal_port);
        let terminal = cx.new(|cx| TerminalSurface::with_transport(cx, Some(terminal_transport)));
        let terminal_refresh = terminal.clone();
        let terminal_poll_task = cx.spawn(async move |_, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(33))
                    .await;
                let events = terminal_refresh.update(cx, |surface, cx| {
                    let events = surface.poll_events();
                    if events > 0 {
                        cx.notify();
                    }
                    events
                });
                if events > 0 {
                    cx.refresh();
                }
            }
        });
        let browser_poll_task = cx.spawn(async move |this, cx| {
            loop {
                cx.background_executor()
                    .timer(Duration::from_millis(33))
                    .await;
                let result = this.update(cx, |this, cx| {
                    let surfaces = this
                        .browser_sessions
                        .values()
                        .map(|session| session.surface.clone())
                        .collect::<Vec<_>>();
                    let mut changed = false;
                    for surface in surfaces {
                        changed |= surface.update(cx, |surface, _| surface.poll_events()) > 0;
                    }
                    if changed {
                        cx.notify();
                    }
                });
                if result.is_err() {
                    break;
                }
                cx.refresh();
            }
        });
        Self {
            host,
            acp,
            runtime,
            inspector_input: InspectorRuntimeInput::default(),
            inspector_inputs,
            inspector_actions,
            runtime_completed: HashSet::new(),
            inspector_mode_menu_open: false,
            inspector_context_page: None,
            inspector_context_curve_open: false,
            inspector_context_ledger_expanded: false,
            inspector_context_show_all: false,
            inspector_context_agents_open: false,
            inspector_plan: None,
            inspector_step: None,
            inspector_task_list: None,
            inspector_task: None,
            inspector_timeline_span: None,
            inspector_timeline_collapsed: Vec::new(),
            inspector_timeline_open: false,
            inspector_git_open: false,
            mode: WorkspaceMode::Threads,
            sidebar_collapsed: false,
            nav_icons: false,
            nav_more: false,
            permission_mode: configured_permission,
            selected_model: configured_model.clone(),
            selected_source: None,
            mode_menu_open: false,
            models_menu_open: false,
            sources_open: false,
            capabilities_open: false,
            stop_confirmation: false,
            configured_model,
            state,
            summaries: Vec::new(),
            archived_summaries: Vec::new(),
            selected_id: None,
            selected_thread: None,
            pending,
            streaming: None,
            permission: None,
            notice: None,
            composer,
            search,
            rename_input,
            thread_name,
            renaming_thread: None,
            rename_input_sync: None,
            thread_name_sync: None,
            settings_state,
            settings_setup,
            settings_inputs,
            settings_focus,
            workspace_inputs,
            conversation_actions,
            workspace_actions,
            queued_turns: Vec::new(),
            held_turns: Vec::new(),
            queued_submissions: HashMap::new(),
            held_submissions: HashMap::new(),
            next_queue_id: 1,
            expanded_thinking: Vec::new(),
            expanded_tools: Vec::new(),
            expanded_steps: Vec::new(),
            transcript_at_end: true,
            clear_composer: false,
            composer_replacement: None,
            composer_composing: false,
            completion_dismissed: false,
            completion_active: 0,
            history_index: -1,
            history_draft: String::new(),
            scheduled_input_sync: None,
            research_input_sync: None,
            pane_layout: PaneLayout::default(),
            inspector_before_browser: None,
            resize_pane: None,
            terminal,
            browser_sessions: HashMap::new(),
            browser_clip_history: Vec::new(),
            browser_input,
            browser_address_sync: None,
            inspector_tab: InspectorTab::Context,
            settings_page: "keybinds".to_string(),
            knowledge_page: KnowledgePage::default(),
            artifacts_page: ArtifactsPage::default(),
            scheduled_page: ScheduledPage::default(),
            scheduled_records: HashMap::new(),
            agent_page: AgentPage::default(),
            plugins_page: PluginsPage::default(),
            research_page: ResearchPage::default(),
            archive_page: ArchivePage::default(),
            _subscriptions: subscriptions,
            _event_task: event_task,
            _acp_event_task: acp_event_task,
            _conversation_action_task: conversation_action_task,
            _workspace_action_task: workspace_action_task,
            _inspector_action_task: inspector_action_task,
            _terminal_worker: terminal_worker,
            _terminal_poll_task: terminal_poll_task,
            _browser_poll_task: browser_poll_task,
        }
    }

    fn handle_settings_input(&mut self, id: InputId, value: String, cx: &mut Context<Self>) {
        if let InputId::NotchGap = id
            && let settings_pages::SettingsPageState::Notch(state) = &mut self.settings_state.page
            && let Ok(gap) = value.trim().parse::<u16>()
        {
            state.notch_gap = gap;
        }
        cx.notify();
    }

    fn update_scheduled_field(
        &mut self,
        field: ScheduledField,
        value: String,
        cx: &mut Context<Self>,
    ) {
        let editor = self
            .scheduled_page
            .editor
            .get_or_insert_with(|| ScheduledEditor {
                draft: default_scheduled_draft(),
                steps: Vec::new(),
                graph_error: None,
                runs: Vec::new(),
                variables: Vec::new(),
                dry_run: false,
            });
        match field {
            ScheduledField::Title => editor.draft.title = value,
            ScheduledField::Model => editor.draft.model = value,
            ScheduledField::Trigger => editor.draft.trigger = value,
            ScheduledField::Prompt => editor.draft.prompt = value,
            ScheduledField::RunsAs => editor.draft.runs_as = value,
        }
        cx.notify();
    }

    fn update_research_field(
        &mut self,
        field: ResearchField,
        value: String,
        cx: &mut Context<Self>,
    ) {
        let form = self.research_page.form.get_or_insert_with(|| ResearchForm {
            title: String::new(),
            optimizing: String::new(),
        });
        match field {
            ResearchField::Title => form.title = value,
            ResearchField::Optimizing => form.optimizing = value,
        }
        cx.notify();
    }

    fn handle_settings_action(
        &mut self,
        action: SettingsAction,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            SettingsAction::SelectPage(page) => {
                self.settings_page = page.id().to_string();
                self.settings_state.page = settings_page_state(
                    page,
                    self.selected_model.as_deref().unwrap_or_default(),
                    &self.permission_mode,
                );
                self.settings_state.status = settings_pages::SettingsAsyncState::Ready;
                self.notice = None;
            }
            SettingsAction::Setup(action) => self.handle_setup_action(action),
            SettingsAction::Notch(settings_pages::NotchAction::SelectModel(model)) => {
                self.selected_model = (!model.is_empty()).then(|| model.to_string());
                if let settings_pages::SettingsPageState::Notch(state) =
                    &mut self.settings_state.page
                {
                    state.model = model;
                }
            }
            SettingsAction::Models(settings_pages::ModelsAction::SelectModel(model)) => {
                self.selected_model = (!model.is_empty()).then(|| model.to_string());
                if let settings_pages::SettingsPageState::Models(state) =
                    &mut self.settings_state.page
                {
                    state.selected_model = model;
                }
            }
            SettingsAction::Tools(settings_pages::ToolsAction::SetDefaultMode(mode)) => {
                self.permission_mode = settings_permission_id(mode).to_string();
                if let settings_pages::SettingsPageState::Tools(state) =
                    &mut self.settings_state.page
                {
                    state.default_mode = mode;
                }
            }
            SettingsAction::Privacy(settings_pages::PrivacyAction::BeginReset) => {
                if let settings_pages::SettingsPageState::Privacy(state) =
                    &mut self.settings_state.page
                {
                    state.reset_confirmation = true;
                }
            }
            SettingsAction::Privacy(settings_pages::PrivacyAction::CancelReset) => {
                if let settings_pages::SettingsPageState::Privacy(state) =
                    &mut self.settings_state.page
                {
                    state.reset_confirmation = false;
                }
            }
            SettingsAction::Privacy(settings_pages::PrivacyAction::ConfirmReset) => {
                if let settings_pages::SettingsPageState::Privacy(state) =
                    &mut self.settings_state.page
                {
                    state.reset_confirmation = false;
                }
                self.notice = Some("Privacy reset is unavailable in the native host".to_string());
            }
            action => {
                let message =
                    format!("Settings action {action:?} is unavailable in the native host");
                self.settings_state.status =
                    settings_pages::SettingsAsyncState::Error(message.clone().into());
                self.notice = Some(message);
            }
        }
        cx.notify();
    }

    fn handle_setup_action(&mut self, action: SetupAction) {
        match action {
            SetupAction::Close => self.settings_setup.open = false,
            SetupAction::Back => {
                if let Some(step) = self.settings_setup.step.previous() {
                    self.settings_setup.step = step;
                }
            }
            SetupAction::Continue | SetupAction::Skip => {
                if let Some(step) = self.settings_setup.step.next() {
                    self.settings_setup.step = step;
                } else {
                    self.settings_setup.open = false;
                }
            }
            SetupAction::SelectModel(model) => {
                self.settings_setup.selected_model = model.clone();
                self.selected_model = (!model.is_empty()).then(|| model.to_string());
            }
            SetupAction::SetVaultFolder(folder) => {
                if let Some(vault) = &mut self.settings_setup.vault {
                    vault.folder = folder;
                }
            }
            SetupAction::ToggleImport(id, selected) => {
                if selected {
                    if !self
                        .settings_setup
                        .selected_imports
                        .iter()
                        .any(|item| item == &id)
                    {
                        self.settings_setup.selected_imports.push(id);
                    }
                } else {
                    self.settings_setup
                        .selected_imports
                        .retain(|item| item != &id);
                }
            }
            SetupAction::ChooseVault(_)
            | SetupAction::PickVaultFolder
            | SetupAction::SaveOpenRouterKey
            | SetupAction::RemoveOpenRouterKey
            | SetupAction::ManageModels
            | SetupAction::ShowQuickAsk
            | SetupAction::OpenCapability(_)
            | SetupAction::ImportSelected
            | SetupAction::Retry => {
                self.notice =
                    Some("This setup action is unavailable in the native host".to_string());
            }
        }
    }

    fn handle_workspace_action(&mut self, action: WorkspaceAction, cx: &mut Context<Self>) {
        match action {
            WorkspaceAction::ChooseKnowledgeVault | WorkspaceAction::ChangeKnowledgeVault => {
                self.notice = Some(
                    "Choosing a knowledge vault is unavailable in the native host".to_string(),
                );
            }
            WorkspaceAction::OpenKnowledgeFolder(id) => {
                self.knowledge_page.selected_folder = Some(id);
            }
            WorkspaceAction::OpenKnowledgeRoot => {
                self.knowledge_page.selected_folder = None;
            }
            WorkspaceAction::OpenKnowledgeNote(_) => {
                self.notice =
                    Some("Opening knowledge notes is unavailable in the native host".to_string());
            }
            WorkspaceAction::CreateKnowledgeFolder
            | WorkspaceAction::MoveKnowledgeNote { .. }
            | WorkspaceAction::RenameKnowledgeFolder { .. }
            | WorkspaceAction::RecolorKnowledgeFolder { .. } => {
                self.notice =
                    Some("Knowledge folder editing is unavailable in the native host".to_string());
            }
            WorkspaceAction::FilterArtifacts(query) => {
                self.artifacts_page.query = query;
            }
            WorkspaceAction::EditScheduledField { field, value } => {
                self.update_scheduled_field(field, value, cx);
            }
            WorkspaceAction::SelectArtifactKind(kind) => {
                self.artifacts_page.kind = kind;
            }
            WorkspaceAction::OpenArtifact(_)
            | WorkspaceAction::EditArtifact(_)
            | WorkspaceAction::RevealArtifact(_)
            | WorkspaceAction::DeleteArtifact(_) => {
                self.notice =
                    Some("Artifact actions are unavailable in the native host".to_string());
            }
            WorkspaceAction::SelectScheduledJob(id) => {
                self.scheduled_page.selected = Some(id.clone());
                let Some(job) = self
                    .scheduled_page
                    .jobs
                    .iter()
                    .find(|job| job.id == id)
                    .cloned()
                else {
                    self.scheduled_page.editor = None;
                    self.scheduled_page.graph = None;
                    self.notice = Some("That scheduled task is no longer available".to_string());
                    cx.notify();
                    return;
                };
                let Some(value) = self.scheduled_records.get(&id) else {
                    self.scheduled_page.editor = None;
                    self.scheduled_page.graph = None;
                    self.notice =
                        Some("The full scheduled task record is still loading".to_string());
                    cx.notify();
                    return;
                };
                let (editor, graph) = scheduled_surfaces(value, &job, &self.permission_mode);
                self.scheduled_page.editor = Some(editor.clone());
                self.scheduled_page.graph = Some(graph);
                self.scheduled_input_sync = Some(editor.draft);
            }
            WorkspaceAction::SelectScheduledMode(mode) => {
                self.scheduled_page.mode = mode;
            }
            WorkspaceAction::NewScheduledTask => {
                self.scheduled_page.selected = None;
                let draft = default_scheduled_draft();
                self.scheduled_page.editor = Some(ScheduledEditor {
                    draft: draft.clone(),
                    steps: Vec::new(),
                    graph_error: None,
                    runs: Vec::new(),
                    variables: Vec::new(),
                    dry_run: false,
                });
                self.scheduled_page.graph = Some(ScheduledGraph {
                    title: "New task".to_string(),
                    trigger: draft.trigger.clone(),
                    steps: Vec::new(),
                    rows: Vec::new(),
                    edges: Vec::new(),
                    selected_step: None,
                    stdin: None,
                    saves_as: None,
                    goes_to: None,
                });
                self.scheduled_input_sync = Some(draft);
            }
            WorkspaceAction::SaveScheduledTask(draft) => {
                if !valid_scheduled_draft(&draft) {
                    self.notice =
                        Some("A scheduled task needs a title, trigger, and prompt".to_string());
                } else {
                    let job_id = draft.id.clone().unwrap_or_default();
                    let nodes = self
                        .scheduled_page
                        .editor
                        .as_ref()
                        .map(scheduled_nodes_json)
                        .unwrap_or_default();
                    self.request_mutation(
                        "saveScheduledJob",
                        json!({
                            "jobId": job_id,
                            "title": draft.title,
                            "schedule": draft.trigger,
                            "prompt": draft.prompt,
                            "nodes": nodes,
                            "sourceDomains": "[]",
                            "permissionMode": host_permission_mode(&draft.runs_as),
                            "model": draft.model,
                        }),
                        "Scheduled task",
                        cx,
                    );
                }
            }
            WorkspaceAction::TestScheduledTask(_) => {
                self.notice =
                    Some("Scheduled dry runs are unavailable in the native host".to_string());
            }
            WorkspaceAction::RunScheduledTask(id) => {
                if id.trim().is_empty() {
                    self.notice = Some("Select a scheduled task before running it".to_string());
                } else {
                    self.request_mutation(
                        "runScheduledJob",
                        json!({"jobId": id, "variables": "{}"}),
                        "Scheduled task run",
                        cx,
                    );
                }
            }
            WorkspaceAction::SetScheduledEnabled { id, enabled } => {
                if id.trim().is_empty() {
                    self.notice =
                        Some("Select a scheduled task before changing its state".to_string());
                } else {
                    self.request_mutation(
                        "setScheduledJobEnabled",
                        json!({"jobId": id, "enabled": enabled.to_string()}),
                        "Scheduled task state",
                        cx,
                    );
                }
            }
            WorkspaceAction::DeleteScheduledTask(id) => {
                self.request_mutation(
                    "deleteScheduledJob",
                    json!({"jobId": id}),
                    "Scheduled task deletion",
                    cx,
                );
            }
            WorkspaceAction::SelectScheduledStep(id) => {
                if let Some(editor) = &mut self.scheduled_page.editor {
                    if let Some(graph) = self.scheduled_page.graph.as_mut() {
                        graph.selected_step = Some(id.clone());
                    }
                    if !editor.steps.iter().any(|step| step.id == id) {
                        self.notice =
                            Some("That scheduled step is no longer available".to_string());
                    }
                }
            }
            WorkspaceAction::SelectAgentTab(tab) => {
                self.agent_page.tab = tab;
            }
            WorkspaceAction::ToggleAgentHistory => {
                self.agent_page.activity.history_open = !self.agent_page.activity.history_open;
            }
            WorkspaceAction::ToggleActivitySpan(span) => {
                self.agent_page.activity.span = span;
            }
            WorkspaceAction::OpenAgentThread(id) => self.select_thread(id, cx),
            WorkspaceAction::OpenAgentMemories => {
                self.notice = Some("Agent memories are unavailable in the native host".to_string());
            }
            WorkspaceAction::SelectPluginTab(tab) => {
                self.plugins_page.tab = tab;
            }
            WorkspaceAction::SearchPlugins(query) => {
                self.plugins_page.query = query;
            }
            WorkspaceAction::EditResearchField { field, value } => {
                self.update_research_field(field, value, cx);
            }
            WorkspaceAction::AddMarketplace
            | WorkspaceAction::SelectMarketplace(_)
            | WorkspaceAction::SelectPluginCategory(_)
            | WorkspaceAction::UpdateMarketplace(_)
            | WorkspaceAction::RemoveMarketplace(_)
            | WorkspaceAction::OpenPlugin(_)
            | WorkspaceAction::InstallPlugin(_)
            | WorkspaceAction::UninstallPlugin(_)
            | WorkspaceAction::ToggleCapability { .. } => {
                self.notice = Some(
                    "Plugin and capability management is unavailable in the native host"
                        .to_string(),
                );
            }
            WorkspaceAction::SelectResearch(id) => {
                self.research_page.selected = Some(id);
                self.research_page.form = None;
            }
            WorkspaceAction::NewResearch => {
                self.research_page.selected = None;
                self.research_page.form = Some(ResearchForm {
                    title: String::new(),
                    optimizing: String::new(),
                });
                self.research_input_sync = Some(ResearchForm {
                    title: String::new(),
                    optimizing: String::new(),
                });
            }
            WorkspaceAction::BackToResearch => {
                self.research_page.selected = None;
                self.research_page.form = None;
            }
            WorkspaceAction::ToggleResearch(id) => {
                let Some(job) = self.research_page.jobs.iter().find(|job| job.id == id) else {
                    self.notice = Some("That research job is no longer available".to_string());
                    cx.notify();
                    return;
                };
                let status = if job.status == "running" {
                    "paused"
                } else {
                    "running"
                };
                self.request_mutation(
                    "setResearchJobStatus",
                    json!({"jobId": id, "status": status}),
                    "Research job state",
                    cx,
                );
            }
            WorkspaceAction::SaveResearch(form) => {
                if form.title.trim().is_empty() || form.optimizing.trim().is_empty() {
                    self.notice =
                        Some("A research experiment needs a title and objective".to_string());
                } else if self.selected_model.as_deref().is_none_or(str::is_empty) {
                    self.notice =
                        Some("Choose a configured model before creating an experiment".to_string());
                } else {
                    let project_dir = env::current_dir()
                        .ok()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_default();
                    if project_dir.is_empty() {
                        self.notice = Some("The current project folder is unavailable".to_string());
                        cx.notify();
                        return;
                    }
                    let job_id = selected_research_job_id(&self.research_page);
                    self.request_mutation(
                        "saveResearchJob",
                        json!({
                            "jobId": job_id,
                            "title": form.title,
                            "projectDir": project_dir,
                            "metricName": form.optimizing,
                            "metricKind": "grep",
                            "direction": "higher",
                            "evalCommand": "true",
                            "prompt": form.optimizing,
                            "proposerModel": self.selected_model.clone().unwrap_or_default(),
                            "permissionMode": host_permission_mode(&self.permission_mode),
                            "maxSeconds": "3600",
                            "maxTokens": "100000",
                            "maxMicroDollars": "1000000",
                        }),
                        "Research experiment",
                        cx,
                    );
                }
            }
            WorkspaceAction::DeleteResearch(id) => {
                self.request_mutation(
                    "deleteResearchJob",
                    json!({"jobId": id}),
                    "Research experiment deletion",
                    cx,
                );
            }
            WorkspaceAction::RestoreArchivedThread(id) => {
                self.request_mutation(
                    "setThreadArchived",
                    json!({"threadId": id, "archived": "false"}),
                    "Thread restore",
                    cx,
                );
            }
        }
        cx.notify();
    }

    fn handle_conversation_action(&mut self, action: ConversationAction, cx: &mut Context<Self>) {
        match action {
            ConversationAction::Composer(action) => self.handle_composer_action(action, cx),
            ConversationAction::CopyTurn { text, .. } => {
                self.remember_browser_clip(&text);
                cx.write_to_clipboard(ClipboardItem::new_string(text));
                self.notice = Some("Copied".to_string());
            }
            ConversationAction::OpenAttachment { .. }
            | ConversationAction::OpenPath(_)
            | ConversationAction::OpenChanges(_)
            | ConversationAction::OpenArtifact(_)
            | ConversationAction::OpenGoal(_)
            | ConversationAction::OpenVisual(_)
            | ConversationAction::KeepVisual(_)
            | ConversationAction::PickVisual(_) => {
                self.notice =
                    Some("This native action is unavailable in the current host".to_string());
            }
            ConversationAction::ToggleThinking(id) => {
                toggle_string(&mut self.expanded_thinking, id)
            }
            ConversationAction::ToggleTool(id) => toggle_string(&mut self.expanded_tools, id),
            ConversationAction::ToggleSteps(id) => toggle_string(&mut self.expanded_steps, id),
            ConversationAction::OpenThread(id) => self.select_thread(id, cx),
            ConversationAction::OpenSettings(page) => {
                self.settings_page = SettingsPageId::from_id(&page)
                    .map_or_else(|| "keybinds".to_string(), |page| page.id().to_string());
                self.settings_state.page = settings_page_state(
                    SettingsPageId::from_id(&self.settings_page)
                        .unwrap_or(SettingsPageId::Keybinds),
                    self.selected_model.as_deref().unwrap_or_default(),
                    &self.permission_mode,
                );
                self.mode = WorkspaceMode::Settings;
            }
            ConversationAction::OpenAgent(_) => self.mode = WorkspaceMode::Agent,
            ConversationAction::CloseAgent => self.mode = WorkspaceMode::Threads,
            ConversationAction::JumpToTurn(id) => {
                self.notice = Some(format!("Turn {id} is selected"));
            }
            ConversationAction::QuoteSelection(text) => {
                self.composer_replacement = Some(text);
            }
            ConversationAction::NewThread(text) => {
                self.composer_replacement = Some(text);
                self.create_thread(cx);
            }
            ConversationAction::ScrollToLatest => self.transcript_at_end = true,
            ConversationAction::TranscriptScrolled { at_end } => self.transcript_at_end = at_end,
            ConversationAction::Retry => self.retry_last_turn(cx),
            ConversationAction::TryAnotherModel => {
                self.selected_model = None;
                self.notice = Some("Choose another configured model before retrying".to_string());
            }
            ConversationAction::RenameThread(id) => self.begin_thread_rename(id),
            ConversationAction::OpenGit => {
                self.inspector_tab = InspectorTab::Machine;
                self.notice = Some("Connect a project folder to open Git".to_string());
            }
            ConversationAction::ToggleTerminal => {
                self.pane_layout.terminal_open = !self.pane_layout.terminal_open;
                if self.pane_layout.terminal_open {
                    let thread_id = self
                        .selected_id
                        .clone()
                        .unwrap_or_else(|| "workspace".to_owned());
                    let cwd = env::current_dir()
                        .map(|path| path.to_string_lossy().into_owned())
                        .unwrap_or_else(|_| ".".to_owned());
                    let result = self.terminal.update(cx, |terminal, cx| {
                        terminal.set_thread(Some(thread_id.clone()));
                        let result = if terminal.controller().list(Some(&thread_id)).is_empty() {
                            terminal.open(TerminalOpen::new(thread_id, cwd)).map(|_| ())
                        } else {
                            Ok(())
                        };
                        cx.notify();
                        result
                    });
                    if let Err(error) = result {
                        self.notice = Some(error.to_string());
                    }
                }
            }
            ConversationAction::ToggleBrowser => {
                if self.pane_layout.browser_open {
                    self.pane_layout.browser_open = false;
                    if let Some(id) = self.selected_id.clone() {
                        self.hide_browser_session(&id, cx);
                    }
                    if self.inspector_before_browser.take() == Some(false) {
                        self.pane_layout.inspector_collapsed = false;
                    }
                } else {
                    if let Some(id) = self.selected_id.clone() {
                        self.ensure_browser_session(&id, cx);
                    }
                    self.inspector_before_browser = Some(self.pane_layout.inspector_collapsed);
                    self.pane_layout.browser_open = true;
                    self.pane_layout.inspector_collapsed = true;
                }
            }
            ConversationAction::ToggleInspector => {
                self.pane_layout.inspector_collapsed = !self.pane_layout.inspector_collapsed;
            }
            ConversationAction::DropQueued(id) => {
                self.queued_turns.retain(|turn| turn.id != id);
                self.queued_submissions.remove(&id);
            }
            ConversationAction::SteerQueued(id) => self.steer_queued(id, cx),
            ConversationAction::ReleaseHeld(id) => {
                if let Some(index) = self.held_turns.iter().position(|turn| turn.id == id) {
                    let turn = self.held_turns.remove(index);
                    if let Some(submission) = self.held_submissions.remove(&id) {
                        self.queued_submissions.insert(id.clone(), submission);
                    }
                    self.queued_turns.push(turn);
                }
            }
            ConversationAction::DropHeld(id) => {
                self.held_turns.retain(|turn| turn.id != id);
                self.held_submissions.remove(&id);
            }
        }
        cx.notify();
    }

    fn handle_composer_action(&mut self, action: ComposerAction, cx: &mut Context<Self>) {
        match action {
            ComposerAction::Send(submission) => {
                if submission.text.trim().is_empty() {
                    self.notice = Some("Write a message before sending".to_string());
                } else if self.streaming.is_some() {
                    self.enqueue_submission(submission);
                } else {
                    self.start_submission(submission, cx);
                }
            }
            ComposerAction::Queue(submission) => {
                self.enqueue_submission(submission);
            }
            ComposerAction::Stop => self.stop_prompt(cx),
            ComposerAction::ConfirmStop => {
                self.stop_confirmation = true;
                self.notice = Some("Press Esc again to stop Emma".to_string());
            }
            ComposerAction::KeepGoing => {
                self.stop_confirmation = false;
                self.notice = Some("The current response will continue".to_string());
            }
            ComposerAction::RestoreDraft => {
                self.notice = Some("No saved draft is available".to_string());
            }
            ComposerAction::SetMode(mode) => {
                self.permission_mode = conversation_permission_id(mode).to_string();
                self.mode_menu_open = false;
            }
            ComposerAction::ToggleModeMenu => self.mode_menu_open = !self.mode_menu_open,
            ComposerAction::OpenSources => self.sources_open = true,
            ComposerAction::CloseSources => {
                self.sources_open = false;
                self.capabilities_open = false;
            }
            ComposerAction::OpenModels => self.models_menu_open = true,
            ComposerAction::CloseModels => self.models_menu_open = false,
            ComposerAction::OpenCapabilities => self.capabilities_open = true,
            ComposerAction::CloseCapabilities => self.capabilities_open = false,
            ComposerAction::OpenAgentRuntime => {
                self.notice =
                    Some("The native agent runtime is already managed by ACP".to_string());
            }
            ComposerAction::SelectModel(model) => {
                self.selected_model = (!model.id.is_empty()).then_some(model.id);
                self.models_menu_open = false;
            }
            ComposerAction::SelectCompletion(id) => {
                let current = self.composer.read(cx).value().to_string();
                self.composer_replacement = Some(replace_active_completion(&current, &id));
                self.completion_dismissed = false;
                self.completion_active = 0;
            }
            ComposerAction::MoveCompletion(delta) => {
                let current = self.composer.read(cx).value().to_string();
                if let Some(menu) =
                    completion_menu_for(&current, self.completion_dismissed, self.completion_active)
                {
                    if menu.items.is_empty() {
                        self.notice = Some(menu.empty_message());
                    } else {
                        self.completion_active =
                            move_completion(self.completion_active, menu.items.len(), delta);
                    }
                }
            }
            ComposerAction::DismissCompletion => {
                self.completion_dismissed = true;
                self.completion_active = 0;
            }
            ComposerAction::SearchSources(query) => {
                self.notice = Some(format!("Searching sources for {query}"));
            }
            ComposerAction::AttachFiles => {
                self.notice = Some("File attachments need the native file picker".to_string());
            }
            ComposerAction::AddSource(source) => {
                self.selected_source = Some(source);
                self.sources_open = false;
            }
            ComposerAction::RemoveAttachment(_) => {
                self.notice = Some("No removable attachment is attached".to_string());
            }
            ComposerAction::InputChanged { text, .. } => {
                self.composer_replacement = Some(text);
                self.completion_dismissed = false;
                self.completion_active = 0;
                self.history_index = -1;
            }
            ComposerAction::CompositionChanged(composing) => {
                self.composer_composing = composing;
            }
            ComposerAction::HistoryPrevious => self.history_previous(cx),
            ComposerAction::HistoryNext => self.history_next(cx),
        }
        cx.notify();
    }

    fn conversation_history(&self) -> Vec<String> {
        self.selected_thread
            .as_ref()
            .map(|thread| {
                thread
                    .messages
                    .iter()
                    .filter(|message| message.role == "user")
                    .map(|message| message.content.clone())
                    .rev()
                    .collect()
            })
            .unwrap_or_default()
    }

    fn history_previous(&mut self, cx: &mut Context<Self>) {
        let history = self.conversation_history();
        if history.is_empty() {
            self.notice =
                Some("Conversation history is unavailable in the native host".to_string());
            return;
        }
        if self.history_index < 0 {
            self.history_draft = self.composer.read(cx).value().to_string();
            self.history_index = 0;
        } else {
            self.history_index = (self.history_index + 1).min(history.len() as isize - 1);
        }
        if let Some(value) = history.get(self.history_index as usize) {
            self.composer_replacement = Some(value.clone());
        }
    }

    fn history_next(&mut self, _cx: &mut Context<Self>) {
        if self.history_index < 0 {
            self.notice = Some("Already at the current draft".to_string());
            return;
        }
        if self.history_index == 0 {
            self.history_index = -1;
            self.composer_replacement = Some(self.history_draft.clone());
        } else {
            self.history_index -= 1;
            let history = self.conversation_history();
            if let Some(value) = history.get(self.history_index as usize) {
                self.composer_replacement = Some(value.clone());
            }
        }
    }

    fn start_submission(
        &mut self,
        submission: conversation::ComposerSubmission,
        cx: &mut Context<Self>,
    ) {
        let Some(thread_id) = self.selected_id.clone() else {
            self.notice = Some("Select a thread before sending".to_string());
            return;
        };
        let prompt = submission.text.trim().to_string();
        if prompt.is_empty() {
            self.notice = Some("Write a message before sending".to_string());
            return;
        }
        let model = (!submission.model.trim().is_empty()).then_some(submission.model.clone());
        self.permission_mode = conversation_permission_id(submission.mode).to_string();
        self.selected_model = model.clone().or_else(|| self.selected_model.clone());
        let mut submission = submission;
        submission.text = prompt.clone();
        self.streaming = Some(StreamingTurn {
            thread_id: thread_id.clone(),
            prompt: prompt.clone(),
            response: String::new(),
            thought: String::new(),
            started_at: Instant::now(),
            model,
        });
        self.notice = None;
        self.clear_composer = true;
        self.history_index = -1;
        self.history_draft.clear();
        let result = self.dispatch_runtime(
            RuntimeCommand::Submit {
                thread_id,
                timestamp: unix_millis().to_string(),
                started_at: unix_millis(),
                submission,
            },
            cx,
        );
        if let Err(error) = result {
            self.streaming = None;
            self.notice = Some(error);
        }
        cx.notify();
    }

    fn enqueue_submission(&mut self, submission: ComposerSubmission) {
        let id = format!("queued-{}", self.next_queue_id);
        self.next_queue_id = self.next_queue_id.saturating_add(1);
        self.queued_submissions
            .insert(id.clone(), submission.clone());
        self.queued_turns.push(QueuedTurn {
            id,
            content: submission.text,
            steerable: true,
        });
    }

    fn steer_queued(&mut self, id: String, cx: &mut Context<Self>) {
        let Some(index) = self.queued_turns.iter().position(|turn| turn.id == id) else {
            self.notice = Some("That queued turn is no longer available".to_string());
            return;
        };
        let turn = self.queued_turns.remove(index);
        let submission = self.queued_submissions.remove(&id).unwrap_or_else(|| {
            conversation::ComposerSubmission {
                text: turn.content,
                mode: conversation_permission(&self.permission_mode),
                model: self.selected_model.clone().unwrap_or_default(),
                source: self.selected_source.clone(),
                capability: None,
                attachments: Vec::new(),
            }
        });
        if let Some(current) = self
            .streaming
            .as_ref()
            .map(|current| current.thread_id.clone())
        {
            let _ = self.acp.cancel(current);
            self.streaming = None;
        }
        self.start_submission(submission, cx);
    }

    fn retry_last_turn(&mut self, cx: &mut Context<Self>) {
        let Some(thread) = self.selected_thread.as_ref() else {
            self.notice = Some("There is no loaded turn to retry".to_string());
            return;
        };
        let Some(prompt) = thread
            .messages
            .iter()
            .rev()
            .find(|message| message.role == "user")
            .map(|message| message.content.clone())
        else {
            self.notice = Some("There is no user turn to retry".to_string());
            return;
        };
        let submission = conversation::ComposerSubmission {
            text: prompt,
            mode: conversation_permission(&self.permission_mode),
            model: self.selected_model.clone().unwrap_or_default(),
            source: self.selected_source.clone(),
            capability: None,
            attachments: Vec::new(),
        };
        self.start_submission(submission, cx);
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(thread_id) = self.selected_id.clone() else {
            return;
        };
        if self.streaming.is_some() {
            return;
        }
        let value = self.composer.read(cx).value().to_string();
        let prompt = value.trim().to_string();
        if prompt.is_empty() {
            return;
        }
        self.composer
            .update(cx, |state, cx| state.set_value("", window, cx));
        self.notice = None;
        self.history_index = -1;
        self.history_draft.clear();
        let model = self.selected_model.clone();
        let submission = ComposerSubmission {
            text: prompt.clone(),
            mode: conversation_permission(&self.permission_mode),
            model: model.clone().unwrap_or_default(),
            source: self.selected_source.clone(),
            capability: None,
            attachments: Vec::new(),
        };
        self.streaming = Some(StreamingTurn {
            thread_id: thread_id.clone(),
            prompt: prompt.clone(),
            response: String::new(),
            thought: String::new(),
            started_at: Instant::now(),
            model: model.clone(),
        });
        let result = self.dispatch_runtime(
            RuntimeCommand::Submit {
                thread_id,
                timestamp: unix_millis().to_string(),
                started_at: unix_millis(),
                submission,
            },
            cx,
        );
        if let Err(error) = result {
            self.streaming = None;
            self.notice = Some(error);
        }
        cx.notify();
    }

    fn stop_prompt(&mut self, cx: &mut Context<Self>) {
        let Some(thread_id) = self.streaming.as_ref().map(|turn| turn.thread_id.clone()) else {
            return;
        };
        if let Err(error) = self.dispatch_runtime(RuntimeCommand::Stop { thread_id }, cx) {
            self.notice = Some(error);
        } else {
            self.permission = None;
            self.stop_confirmation = false;
            self.notice = Some("Stopping the current response…".to_string());
        }
        cx.notify();
    }

    fn handle_event(&mut self, event: HostEvent, cx: &mut Context<Self>) {
        match event {
            HostEvent::Error(error) => {
                if self
                    .pending
                    .values()
                    .any(|kind| matches!(kind, RequestKind::RecordTurn(_)))
                {
                    self.streaming = None;
                    self.notice = Some(error);
                } else {
                    self.state = LoadState::Failed(error.clone());
                    self.set_page_error(&error);
                }
                self.pending.clear();
            }
            HostEvent::DueJob(job) => drop(job),
            HostEvent::Response { id, result } => {
                let Some(kind) = self.pending.remove(&id) else {
                    return;
                };
                match result {
                    Ok(value) => self.handle_result(kind, value, cx),
                    Err(error) => match kind {
                        RequestKind::RecordTurn(_) => {
                            self.streaming = None;
                            self.notice = Some(error);
                        }
                        _ => {
                            self.state = LoadState::Failed(error.clone());
                            self.set_page_error(&error);
                        }
                    },
                }
            }
        }
        cx.notify();
    }

    fn handle_acp_event(&mut self, event: AcpEvent, cx: &mut Context<Self>) {
        match event {
            AcpEvent::Ready => {}
            AcpEvent::TextDelta { thread_id, text } => {
                if let Some(turn) = self
                    .streaming
                    .as_mut()
                    .filter(|turn| turn.thread_id == thread_id)
                {
                    turn.response.push_str(&text);
                }
            }
            AcpEvent::ThoughtDelta { thread_id, text } => {
                if let Some(turn) = self
                    .streaming
                    .as_mut()
                    .filter(|turn| turn.thread_id == thread_id)
                {
                    turn.thought.push_str(&text);
                }
            }
            AcpEvent::PromptFinished {
                thread_id,
                stop_reason,
                usage,
            } => {
                let Some(turn) = self
                    .streaming
                    .as_ref()
                    .filter(|turn| turn.thread_id == thread_id)
                else {
                    return;
                };
                if turn.response.trim().is_empty() && stop_reason == "refused" {
                    self.streaming = None;
                    self.notice = Some("Emma refused the request".to_string());
                } else {
                    let response = if turn.response.trim().is_empty() {
                        format!("(the run ended: {stop_reason})")
                    } else {
                        turn.response.trim().to_string()
                    };
                    let thinking = turn.thought.trim().to_string();
                    let params = recorded_turn_params(
                        &turn.thread_id,
                        &turn.prompt,
                        &thinking,
                        &response,
                        &usage,
                        turn.started_at.elapsed(),
                        turn.model.as_deref(),
                    );
                    match self.host.request("recordTurn", params) {
                        Ok(id) => {
                            self.pending.insert(id, RequestKind::RecordTurn(thread_id));
                            self.notice = Some("Saving Emma's response…".to_string());
                        }
                        Err(error) => {
                            self.streaming = None;
                            self.notice = Some(error);
                        }
                    }
                }
            }
            AcpEvent::PermissionAsked {
                thread_id,
                session_id,
                permission_mode,
                request_id,
                title,
                options,
                ..
            } => {
                self.permission = Some(PermissionPrompt {
                    thread_id,
                    session_id,
                    permission_mode,
                    request_id,
                    title,
                    options,
                });
                self.notice = Some("Emma is waiting for permission".to_string());
            }
            AcpEvent::Error { thread_id, message } => {
                let relevant = thread_id.is_none()
                    || self
                        .streaming
                        .as_ref()
                        .is_some_and(|turn| Some(turn.thread_id.clone()) == thread_id);
                if relevant {
                    self.streaming = None;
                    self.notice = Some(message);
                }
            }
            AcpEvent::ChildExited => {
                self.permission = None;
                let was_streaming = self.streaming.take().is_some();
                if was_streaming && self.notice.is_none() {
                    self.notice = Some("The native agent process exited".to_string());
                }
            }
        }
        cx.notify();
    }

    fn handle_result(&mut self, kind: RequestKind, value: Value, cx: &mut Context<Self>) {
        match kind {
            RequestKind::Snapshot => self.apply_snapshot(value),
            RequestKind::ThreadSummaries => {
                let result = value
                    .get("threads")
                    .cloned()
                    .ok_or_else(|| "thread summaries response is invalid".to_string())
                    .and_then(|threads| {
                        serde_json::from_value::<Vec<ThreadSummary>>(threads).map_err(|error| {
                            format!("thread summaries response is invalid: {error}")
                        })
                    });
                match result {
                    Ok(threads) => {
                        let (archived, live): (Vec<_>, Vec<_>) = threads
                            .into_iter()
                            .partition(|thread| thread.archived_at.is_some());
                        self.archived_summaries = archived;
                        self.summaries = live;
                        self.update_archive_page();
                        if self.summaries.is_empty() {
                            self.selected_id = None;
                            self.selected_thread = None;
                            self.thread_name_sync = Some("New thread".to_owned());
                            self.state = LoadState::Empty;
                        } else {
                            self.state = LoadState::Ready;
                            let selected = self
                                .selected_id
                                .clone()
                                .filter(|id| self.summaries.iter().any(|thread| &thread.id == id))
                                .unwrap_or_else(|| self.summaries[0].id.clone());
                            self.select_thread(selected, cx);
                        }
                    }
                    Err(error) => self.state = LoadState::Failed(error),
                }
            }
            RequestKind::Thread(id) => match serde_json::from_value::<ThreadData>(value) {
                Ok(thread) => {
                    if self.selected_id.as_deref() == Some(id.as_str()) {
                        self.selected_model =
                            thread_model(&thread).or_else(|| self.configured_model.clone());
                        self.thread_name_sync = Some(thread.title.clone());
                        self.selected_thread = Some(thread);
                        self.state = LoadState::Ready;
                    }
                }
                Err(error) => {
                    self.state = LoadState::Failed(format!("thread response is invalid: {error}"));
                }
            },
            RequestKind::CreateThread => {
                match serde_json::from_value::<ThreadData>(value) {
                    Ok(thread) => {
                        if let Some(previous) = self.selected_id.clone()
                            && previous != thread.id
                        {
                            self.hide_browser_session(&previous, cx);
                        }
                        self.ensure_browser_session(&thread.id, cx);
                        self.selected_id = Some(thread.id.clone());
                        self.thread_name_sync = Some(thread.title.clone());
                        self.selected_thread = Some(thread);
                        self.state = LoadState::Ready;
                    }
                    Err(error) => {
                        self.notice = Some(format!("created thread response is invalid: {error}"));
                    }
                }
                self.request_summaries();
            }
            RequestKind::RecordTurn(id) => match serde_json::from_value::<ThreadData>(value) {
                Ok(thread) => {
                    if self
                        .streaming
                        .as_ref()
                        .is_some_and(|turn| turn.thread_id == id)
                    {
                        self.streaming = None;
                    }
                    if self.selected_id.as_deref() == Some(id.as_str()) {
                        self.selected_model =
                            thread_model(&thread).or_else(|| self.configured_model.clone());
                        self.thread_name_sync = Some(thread.title.clone());
                        self.selected_thread = Some(thread);
                        self.notice = None;
                        self.state = LoadState::Ready;
                    }
                    self.request_summaries();
                }
                Err(error) => {
                    if self
                        .streaming
                        .as_ref()
                        .is_some_and(|turn| turn.thread_id == id)
                    {
                        self.streaming = None;
                    }
                    self.notice = Some(format!("recorded thread response is invalid: {error}"));
                }
            },
            RequestKind::WorkspaceMutation { label, refresh } => {
                self.notice = Some(format!("{label} completed"));
                if refresh {
                    self.request_snapshot();
                    self.request_summaries();
                }
            }
        }
    }

    fn apply_snapshot(&mut self, value: Value) {
        let Some(object) = value.as_object() else {
            self.set_page_error("workspace snapshot is invalid");
            return;
        };
        let threads = object
            .get("threads")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let scheduled_values = object
            .get("scheduledJobs")
            .and_then(Value::as_array)
            .cloned()
            .unwrap_or_default();
        let scheduled = scheduled_values
            .iter()
            .filter_map(parse_scheduled_job)
            .collect::<Vec<_>>();
        let research = object
            .get("researchJobs")
            .and_then(Value::as_array)
            .map(|jobs| {
                jobs.iter()
                    .filter_map(parse_research_job)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let live_threads = threads
            .iter()
            .filter(|thread| thread.get("archivedAt").is_none_or(Value::is_null))
            .count();
        let subagents = threads
            .iter()
            .filter(|thread| thread.get("kind").and_then(Value::as_str) == Some("subagent"))
            .count();
        let turns = threads.iter().map(thread_message_count).sum::<usize>();
        self.knowledge_page.state = KnowledgeState::NoVault;
        self.artifacts_page.status = PageStatus::Empty;
        self.scheduled_page.status = if scheduled.is_empty() {
            PageStatus::Empty
        } else {
            PageStatus::Ready
        };
        self.scheduled_page.jobs = scheduled.clone();
        self.scheduled_records = scheduled_values
            .iter()
            .filter_map(|value| Some((value_text(value.get("id"))?, value.clone())))
            .collect();
        let selected_scheduled = self
            .scheduled_page
            .selected
            .clone()
            .and_then(|id| {
                scheduled_values
                    .iter()
                    .find(|value| value_text(value.get("id")).as_deref() == Some(id.as_str()))
            })
            .or_else(|| scheduled_values.first());
        if let Some(value) = selected_scheduled {
            let job = parse_scheduled_job(value);
            if let Some(job) = job {
                let (editor, graph) = scheduled_surfaces(value, &job, &self.permission_mode);
                self.scheduled_page.selected = Some(job.id);
                self.scheduled_page.editor = Some(editor.clone());
                self.scheduled_page.graph = Some(graph);
                self.scheduled_input_sync = Some(editor.draft);
            }
        } else {
            self.scheduled_page.selected = None;
            self.scheduled_page.editor = None;
            self.scheduled_page.graph = None;
        }
        self.agent_page.status = PageStatus::Ready;
        self.agent_page.activity.live_threads = live_threads;
        self.agent_page.activity.subagents = subagents;
        self.agent_page.activity.turns = turns;
        self.plugins_page.status = PageStatus::Empty;
        self.plugins_page.usage_loading = false;
        self.research_page.status = if research.is_empty() {
            PageStatus::Empty
        } else {
            PageStatus::Ready
        };
        self.research_page.jobs = research;
        if let Some(id) = self.research_page.selected.as_ref()
            && !self.research_page.jobs.iter().any(|job| &job.id == id)
        {
            self.research_page.selected = None;
        }
        self.archive_page.threads = threads
            .iter()
            .filter_map(|thread| {
                let archived_at = thread.get("archivedAt").and_then(Value::as_str)?;
                Some(emma_app::workspace_pages::ArchivedThread {
                    id: thread.get("id").and_then(Value::as_str)?.to_string(),
                    title: thread
                        .get("title")
                        .and_then(Value::as_str)
                        .unwrap_or("Archived thread")
                        .to_string(),
                    archived_at: archived_at.to_string(),
                    messages: thread_message_count(thread),
                })
            })
            .collect();
        self.archive_page.status = if self.archive_page.threads.is_empty() {
            PageStatus::Empty
        } else {
            PageStatus::Ready
        };
        if let Some(warning) = object
            .get("warnings")
            .and_then(Value::as_array)
            .and_then(|warnings| warnings.iter().find_map(Value::as_str))
        {
            self.notice = Some(warning.to_string());
        }
    }

    fn update_archive_page(&mut self) {
        self.archive_page.threads = self
            .archived_summaries
            .iter()
            .filter_map(|thread| {
                Some(emma_app::workspace_pages::ArchivedThread {
                    id: thread.id.clone(),
                    title: thread
                        .display_title
                        .clone()
                        .unwrap_or_else(|| thread.title.clone()),
                    archived_at: thread.archived_at.clone()?,
                    messages: thread.messages,
                })
            })
            .collect();
        self.archive_page.status = if self.archive_page.threads.is_empty() {
            PageStatus::Empty
        } else {
            PageStatus::Ready
        };
    }

    fn set_page_error(&mut self, message: &str) {
        let message = message.to_string();
        self.knowledge_page.state = KnowledgeState::Error(message.clone());
        self.artifacts_page.status = PageStatus::Error(message.clone());
        self.scheduled_page.status = PageStatus::Error(message.clone());
        self.agent_page.status = PageStatus::Error(message.clone());
        self.plugins_page.status = PageStatus::Error(message.clone());
        self.research_page.status = PageStatus::Error(message.clone());
        self.archive_page.status = PageStatus::Error(message);
    }

    fn request_summaries(&mut self) {
        self.state = LoadState::Loading;
        if let Ok(id) = self.host.request("threadSummaries", Value::Null) {
            self.pending.insert(id, RequestKind::ThreadSummaries);
        }
    }

    fn request_snapshot(&mut self) {
        if let Ok(id) = self.host.request("snapshot", Value::Null) {
            self.pending.insert(id, RequestKind::Snapshot);
        }
    }

    fn request_mutation(
        &mut self,
        method: &str,
        params: Value,
        label: &str,
        cx: &mut Context<Self>,
    ) {
        match self.host.request(method, params) {
            Ok(id) => {
                self.pending.insert(
                    id,
                    RequestKind::WorkspaceMutation {
                        label: label.to_string(),
                        refresh: true,
                    },
                );
                self.notice = Some(format!("{label}…"));
            }
            Err(error) => self.notice = Some(error),
        }
        cx.notify();
    }

    fn ensure_browser_session(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        if self.browser_sessions.contains_key(thread_id) {
            return;
        }
        let surface = cx.new(|cx| BrowserSurface::new(cx));
        self.browser_sessions.insert(
            thread_id.to_owned(),
            BrowserSession {
                surface,
                pane: BrowserPaneState::new(BrowserPaneKind::Browser),
            },
        );
    }

    fn hide_browser_session(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        let Some(surface) = self
            .browser_sessions
            .get(thread_id)
            .map(|session| session.surface.clone())
        else {
            return;
        };
        let _ = surface.update(cx, |surface, cx| {
            surface.controller_mut().hide();
            surface.sync_native(cx);
        });
    }

    fn sync_browser(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let thread_ids = self.browser_sessions.keys().cloned().collect::<Vec<_>>();
        for thread_id in thread_ids {
            let Some(surface) = self
                .browser_sessions
                .get(&thread_id)
                .map(|session| session.surface.clone())
            else {
                continue;
            };
            let events = surface.update(cx, |surface, _| {
                surface.poll_events();
                surface.take_events()
            });
            for event in events {
                self.handle_browser_event(&thread_id, event, window, cx);
            }
            self.sync_browser_pane_state(&thread_id, cx);
        }
        self.sync_browser_layout(window, cx);
    }

    fn sync_browser_pane_state(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        let Some(surface) = self
            .browser_sessions
            .get(thread_id)
            .map(|session| session.surface.clone())
        else {
            return;
        };
        let status = surface.update(cx, |surface, _| surface.controller().status());
        if let Some(session) = self.browser_sessions.get_mut(thread_id) {
            session.pane.reduce(BrowserPaneAction::SetStatus(status));
        }
    }

    fn sync_browser_layout(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let viewport = window.viewport_size();
        let width = self.pane_layout.browser_width.clamp(
            emma_app::pane_layout::MIN_BROWSER_WIDTH,
            emma_app::pane_layout::WIDE_BROWSER_WIDTH,
        );
        let terminal_height = if self.pane_layout.terminal_open {
            self.pane_layout.terminal_height.clamp(
                emma_app::pane_layout::MIN_TERMINAL_HEIGHT,
                emma_app::pane_layout::MAX_TERMINAL_HEIGHT,
            )
        } else {
            0.
        };
        let top = emma_app::browser_pane::BROWSER_TABS_HEIGHT
            + emma_app::browser_pane::BROWSER_BAR_HEIGHT;
        let height = (viewport.height.as_f32() - top - terminal_height).max(1.);
        let x = (viewport.width.as_f32() - width).max(0.);
        let shown = self.mode == WorkspaceMode::Threads
            && self.pane_layout.browser_open
            && self.selected_id.is_some();
        let active_id = self.selected_id.as_deref();
        let surfaces = self
            .browser_sessions
            .iter()
            .map(|(thread_id, session)| (thread_id.clone(), session.surface.clone()))
            .collect::<Vec<_>>();
        for (thread_id, surface) in surfaces {
            let active = active_id == Some(thread_id.as_str());
            let _ = surface.update(cx, |surface, cx| {
                if shown && active {
                    let bounds = emma_app::browser_surface::BrowserBounds::new(
                        x.round() as i32,
                        top.round() as i32,
                        width.round() as u32,
                        height.round() as u32,
                    );
                    let _ = surface.controller_mut().place(Some(bounds));
                } else {
                    let _ = surface.controller_mut().place(None);
                }
                surface.sync_native(cx);
            });
        }
    }

    fn handle_browser_event(
        &mut self,
        thread_id: &str,
        event: BrowserEvent,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match event {
            BrowserEvent::PopupRequested { url, .. } => self.handle_browser_action_for_thread(
                thread_id,
                BrowserPaneAction::Popup(url),
                window,
                cx,
            ),
            BrowserEvent::DownloadRequested { url, .. } => self.handle_browser_action_for_thread(
                thread_id,
                BrowserPaneAction::Download(url),
                window,
                cx,
            ),
            BrowserEvent::NavigationBlocked { error, .. } => self.handle_browser_action_for_thread(
                thread_id,
                BrowserPaneAction::NavigationBlocked(error),
                window,
                cx,
            ),
            BrowserEvent::IpcMessage { tab_id, uri, body } => {
                self.handle_browser_ipc(thread_id, &tab_id, &uri, &body, cx);
            }
            BrowserEvent::Closed { tab_id } => {
                if let Some(session) = self.browser_sessions.get_mut(thread_id) {
                    session
                        .pane
                        .set_error(format!("Browser tab {tab_id} closed unexpectedly"));
                }
            }
            BrowserEvent::Navigated { .. }
            | BrowserEvent::Loading { .. }
            | BrowserEvent::TitleChanged { .. }
            | BrowserEvent::FaviconChanged { .. }
            | BrowserEvent::HistoryChanged { .. } => {}
        }
    }

    fn handle_browser_ipc(
        &mut self,
        thread_id: &str,
        tab_id: &str,
        uri: &str,
        body: &str,
        cx: &mut Context<Self>,
    ) {
        let Some(surface) = self
            .browser_sessions
            .get(thread_id)
            .map(|session| session.surface.clone())
        else {
            return;
        };
        let tab = surface.update(cx, |surface, _| {
            surface
                .controller()
                .tab(tab_id)
                .map(|tab| (tab.surface, tab.url.clone()))
        });
        let Some((surface_kind, authorized_url)) = tab else {
            return;
        };
        let message = parse_frame_bridge_message(surface_kind, &authorized_url, uri, body);
        let request_id = bridge_request_id(body);
        let Ok(message) = message else {
            if let Some(request_id) = request_id {
                let reply = BridgeReply::failed(request_id, "native bridge request rejected");
                let _ = surface.update(cx, |surface, cx| surface.reply_bridge(tab_id, reply, cx));
            }
            self.notice = Some("A browser frame request was rejected".to_string());
            return;
        };
        match message.capability {
            BridgeCapability::VisualHeight => {
                if let Some(height) = message.payload.get("height").and_then(Value::as_u64) {
                    if let Some(session) = self.browser_sessions.get_mut(thread_id) {
                        session
                            .pane
                            .reduce(BrowserPaneAction::VisualMeasure(height as u32));
                    }
                }
            }
            BridgeCapability::VisualPick => {
                if let (Some(label), Some(html)) = (
                    message.payload.get("label").and_then(Value::as_str),
                    message.payload.get("html").and_then(Value::as_str),
                ) {
                    if let Some(session) = self.browser_sessions.get_mut(thread_id) {
                        session.pane.reduce(BrowserPaneAction::VisualPicked {
                            label: label.to_owned(),
                            html: html.to_owned(),
                        });
                    }
                }
            }
            BridgeCapability::ArtifactSql
            | BridgeCapability::ComponentFetch
            | BridgeCapability::ComponentShot
            | BridgeCapability::EmmaRequest
            | BridgeCapability::EmmaSubscribe => {
                if let Some(request_id) = message.request_id {
                    let reply = BridgeReply::failed(
                        request_id,
                        "this native frame capability is not available",
                    );
                    let _ =
                        surface.update(cx, |surface, cx| surface.reply_bridge(tab_id, reply, cx));
                }
                self.notice = Some("This browser frame capability is unavailable".to_string());
            }
            BridgeCapability::OpenExternal => {
                self.notice =
                    Some("External navigation is handled by the browser pane".to_string());
            }
        }
        if let Some(request_id) = message.request_id
            && matches!(
                message.capability,
                BridgeCapability::VisualHeight | BridgeCapability::VisualPick
            )
        {
            let reply = BridgeReply::ok(request_id, Value::Null);
            let _ = surface.update(cx, |surface, cx| surface.reply_bridge(tab_id, reply, cx));
        }
    }

    fn handle_browser_action(
        &mut self,
        action: BrowserPaneAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(thread_id) = self.selected_id.clone() else {
            self.notice = Some("Select a thread before opening the browser".to_string());
            cx.notify();
            return;
        };
        self.handle_browser_action_for_thread(&thread_id, action, window, cx);
    }

    fn handle_browser_action_for_thread(
        &mut self,
        thread_id: &str,
        action: BrowserPaneAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.ensure_browser_session(thread_id, cx);
        let begin_address_edit = matches!(action, BrowserPaneAction::BeginAddressEdit);
        let effect = self
            .browser_sessions
            .get_mut(thread_id)
            .and_then(|session| session.pane.reduce(action));
        if begin_address_edit {
            self.browser_address_sync = self
                .browser_sessions
                .get(thread_id)
                .and_then(|session| session.pane.active_tab())
                .map(|tab| tab.url.clone());
        }
        if let Some(effect) = effect {
            self.apply_browser_effect(thread_id, effect, window, cx);
        }
        cx.notify();
    }

    fn apply_browser_effect(
        &mut self,
        thread_id: &str,
        effect: BrowserPaneEffect,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match effect {
            BrowserPaneEffect::SelectTab(tab_id) => self.request_browser_command(
                thread_id,
                |controller| controller.select_tab(&tab_id),
                window,
                cx,
            ),
            BrowserPaneEffect::NewTab => self.request_browser_command(
                thread_id,
                |controller| controller.new_tab(None),
                window,
                cx,
            ),
            BrowserPaneEffect::CloseTab(tab_id) => self.request_browser_command(
                thread_id,
                |controller| Ok(controller.close_tab(&tab_id)),
                window,
                cx,
            ),
            BrowserPaneEffect::Navigate(navigation) => self.request_browser_command(
                thread_id,
                |controller| Ok(controller.navigate(navigation)),
                window,
                cx,
            ),
            BrowserPaneEffect::AddressSubmitted(url) => self.request_browser_command(
                thread_id,
                |controller| controller.open(&url),
                window,
                cx,
            ),
            BrowserPaneEffect::ClipboardRequested => self.refresh_browser_clips(thread_id, cx),
            BrowserPaneEffect::ClipboardUse(index) => self.use_browser_clip(thread_id, index, cx),
            BrowserPaneEffect::Float(floating) => {
                if let Some(surface) = self
                    .browser_sessions
                    .get(thread_id)
                    .map(|session| session.surface.clone())
                {
                    let _ = surface.update(cx, |surface, _| {
                        surface.controller_mut().set_floating(floating);
                    });
                }
                if floating {
                    self.notice = Some(
                        "The native browser stays docked until a floating window is available"
                            .to_string(),
                    );
                }
            }
            BrowserPaneEffect::Wide(wide) => {
                self.pane_layout.browser_width = if wide {
                    emma_app::pane_layout::WIDE_BROWSER_WIDTH
                } else {
                    emma_app::pane_layout::MIN_BROWSER_WIDTH
                };
                self.pane_layout = self
                    .pane_layout
                    .clone()
                    .validated(f64::from(window.viewport_size().width.as_f32()));
            }
            BrowserPaneEffect::Hide => {
                self.pane_layout.browser_open = false;
                self.hide_browser_session(thread_id, cx);
            }
            BrowserPaneEffect::Close => {
                self.pane_layout.browser_open = false;
                self.request_browser_command(
                    thread_id,
                    |controller| Ok(controller.navigate(Navigation::Close)),
                    window,
                    cx,
                );
            }
            BrowserPaneEffect::OpenExternal(url) | BrowserPaneEffect::Download(url) => {
                match open_external_url(&url) {
                    Ok(()) => self.notice = Some("Opened the link externally".to_string()),
                    Err(error) => self.notice = Some(error),
                }
            }
            BrowserPaneEffect::PopupNewTab(url) => self.request_browser_command(
                thread_id,
                |controller| controller.new_tab(Some(&url)),
                window,
                cx,
            ),
            BrowserPaneEffect::Blocked(error) => self.notice = Some(error.to_string()),
            BrowserPaneEffect::Retry => self.request_browser_command(
                thread_id,
                |controller| Ok(controller.navigate(Navigation::Reload)),
                window,
                cx,
            ),
            BrowserPaneEffect::Component(effect) => {
                self.apply_component_browser_effect(thread_id, effect, cx);
            }
            BrowserPaneEffect::Visual(effect) => {
                self.apply_visual_browser_effect(thread_id, effect, cx);
            }
        }
    }

    fn request_browser_command<F>(
        &mut self,
        thread_id: &str,
        operation: F,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) where
        F: FnOnce(
            &mut emma_app::browser_surface::BrowserController,
        ) -> Result<BrowserCommand, SecurityError>,
    {
        let Some(surface) = self
            .browser_sessions
            .get(thread_id)
            .map(|session| session.surface.clone())
        else {
            self.browser_failure(thread_id, "browser session is unavailable", cx);
            return;
        };
        let result = surface.update(cx, |surface, _| operation(surface.controller_mut()));
        let command = match result {
            Ok(command) => command,
            Err(error) => {
                self.browser_failure(thread_id, &error.to_string(), cx);
                return;
            }
        };
        self.execute_browser_command(thread_id, command, window, cx);
    }

    fn execute_browser_command(
        &mut self,
        thread_id: &str,
        command: BrowserCommand,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(surface) = self
            .browser_sessions
            .get(thread_id)
            .map(|session| session.surface.clone())
        else {
            self.browser_failure(thread_id, "browser session is unavailable", cx);
            return;
        };
        let result = surface.update(cx, |surface, cx| {
            match command {
                BrowserCommand::Load { tab_id, .. } => surface.mount_tab(&tab_id, window, cx)?,
                BrowserCommand::Back { tab_id } => {
                    surface.navigate_native(&tab_id, Navigation::Back, cx)?;
                }
                BrowserCommand::Forward { tab_id } => {
                    surface.navigate_native(&tab_id, Navigation::Forward, cx)?;
                }
                BrowserCommand::Reload { tab_id } => {
                    surface.navigate_native(&tab_id, Navigation::Reload, cx)?;
                }
                BrowserCommand::Close { tab_id } => surface.close_tab_native(&tab_id, cx),
                BrowserCommand::CloseAll => surface.unmount_all(),
                BrowserCommand::Focus { .. } => surface.focus_native(cx),
                BrowserCommand::Noop => {}
            }
            surface.sync_native(cx);
            Ok::<(), BrowserError>(())
        });
        match result {
            Ok(()) => self.sync_browser_pane_state(thread_id, cx),
            Err(error) => self.browser_failure(thread_id, &error.to_string(), cx),
        }
    }

    fn browser_failure(&mut self, thread_id: &str, message: &str, cx: &mut Context<Self>) {
        if let Some(session) = self.browser_sessions.get_mut(thread_id) {
            session.pane.set_error(message.to_owned());
        }
        self.notice = Some(message.to_owned());
        cx.notify();
    }

    fn refresh_browser_clips(&mut self, thread_id: &str, cx: &mut Context<Self>) {
        if let Some(text) = cx.read_from_clipboard().and_then(|item| item.text()) {
            self.remember_browser_clip(&text);
        }
        let clips = self.browser_clip_history.clone();
        if let Some(session) = self.browser_sessions.get_mut(thread_id) {
            session.pane.set_clips(Some(clips));
        }
    }

    fn use_browser_clip(&mut self, thread_id: &str, index: usize, cx: &mut Context<Self>) {
        let Some(text) = self.browser_clip_history.get(index).cloned() else {
            self.notice = Some("That clipboard item is no longer available".to_string());
            return;
        };
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        if let Some(surface) = self
            .browser_sessions
            .get(thread_id)
            .map(|session| session.surface.clone())
        {
            let _ = surface.update(cx, |surface, cx| surface.focus_native(cx));
        }
    }

    fn remember_browser_clip(&mut self, text: &str) {
        let mut value = String::new();
        for character in text.chars() {
            if value.len().saturating_add(character.len_utf8())
                > emma_app::browser_pane::MAX_CLIP_BYTES
            {
                break;
            }
            value.push(character);
        }
        if value.is_empty() {
            return;
        }
        self.browser_clip_history.retain(|clip| clip != &value);
        self.browser_clip_history.insert(0, value);
        self.browser_clip_history
            .truncate(emma_app::browser_pane::MAX_CLIPS);
    }

    fn apply_component_browser_effect(
        &mut self,
        thread_id: &str,
        effect: ComponentPaneEffect,
        cx: &mut Context<Self>,
    ) {
        match effect {
            ComponentPaneEffect::SetExpanded(expanded) => {
                if let Some(tab_id) = self.browser_active_tab(thread_id, cx) {
                    if let Some(surface) = self
                        .browser_sessions
                        .get(thread_id)
                        .map(|session| session.surface.clone())
                    {
                        let _ = surface.update(cx, |surface, cx| {
                            surface.set_component_expanded(&tab_id, expanded, cx)
                        });
                    }
                }
            }
            ComponentPaneEffect::CloseFullscreen => {}
            ComponentPaneEffect::AllowFullscreen(_)
            | ComponentPaneEffect::SwitchOff
            | ComponentPaneEffect::Delete
            | ComponentPaneEffect::Screenshot { .. } => {
                self.notice =
                    Some("Component controls are unavailable in this native frame".to_string());
            }
        }
    }

    fn apply_visual_browser_effect(
        &mut self,
        thread_id: &str,
        effect: VisualPaneEffect,
        cx: &mut Context<Self>,
    ) {
        match effect {
            VisualPaneEffect::SetPicking(picking) => {
                if let Some(tab_id) = self.browser_active_tab(thread_id, cx) {
                    if let Some(surface) = self
                        .browser_sessions
                        .get(thread_id)
                        .map(|session| session.surface.clone())
                    {
                        let _ = surface.update(cx, |surface, cx| {
                            surface.set_visual_picking(&tab_id, picking, cx)
                        });
                    }
                }
            }
            VisualPaneEffect::Picked { .. }
            | VisualPaneEffect::Export { .. }
            | VisualPaneEffect::Keep { .. } => {
                self.notice =
                    Some("Visual actions are unavailable in this native frame".to_string());
            }
        }
    }

    fn browser_active_tab(&self, thread_id: &str, cx: &mut Context<Self>) -> Option<String> {
        self.browser_sessions
            .get(thread_id)
            .and_then(|session| session.surface.read(cx).controller().active_tab_id())
            .map(ToOwned::to_owned)
    }

    fn select_thread(&mut self, id: String, cx: &mut Context<Self>) {
        if self.selected_id.as_deref() != Some(id.as_str()) {
            if let Some(previous) = self.selected_id.clone() {
                self.hide_browser_session(&previous, cx);
            }
        }
        self.ensure_browser_session(&id, cx);
        self.selected_id = Some(id.clone());
        self.selected_thread = None;
        self.state = LoadState::Loading;
        if let Ok(request_id) = self.host.request("thread", json!({"threadId": id})) {
            self.pending.insert(request_id, RequestKind::Thread(id));
        } else {
            self.state = LoadState::Failed("could not request thread".to_string());
        }
        cx.notify();
    }

    fn create_thread(&mut self, cx: &mut Context<Self>) {
        if self
            .pending
            .values()
            .any(|kind| matches!(kind, RequestKind::CreateThread))
        {
            return;
        }
        if let Ok(id) = self.host.request("createThread", json!({})) {
            self.pending.insert(id, RequestKind::CreateThread);
            self.state = LoadState::Loading;
            cx.notify();
        }
    }

    fn begin_thread_rename(&mut self, id: String) {
        let title = self
            .summaries
            .iter()
            .find(|thread| thread.id == id)
            .map(|thread| {
                thread
                    .display_title
                    .clone()
                    .unwrap_or_else(|| thread.title.clone())
            })
            .or_else(|| {
                self.selected_thread
                    .as_ref()
                    .filter(|thread| thread.id == id)
                    .map(|thread| thread.title.clone())
            })
            .unwrap_or_default();
        self.renaming_thread = Some(id);
        self.rename_input_sync = Some(title);
    }

    fn commit_thread_rename(&mut self, title: String, cx: &mut Context<Self>) {
        let Some(id) = self.renaming_thread.take() else {
            return;
        };
        let title = title.trim();
        if title.is_empty() {
            cx.notify();
            return;
        }
        let unchanged = self.summaries.iter().any(|thread| {
            thread.id == id
                && thread
                    .display_title
                    .as_deref()
                    .unwrap_or(&thread.title)
                    .trim()
                    == title
        });
        if !unchanged {
            self.request_mutation(
                "renameThread",
                json!({"threadId": id, "title": title}),
                "Thread rename",
                cx,
            );
        }
        cx.notify();
    }

    fn commit_selected_thread_name(&mut self, title: String, cx: &mut Context<Self>) {
        let Some(id) = self.selected_id.clone() else {
            return;
        };
        let current = self
            .selected_thread
            .as_ref()
            .map(|thread| thread.title.clone())
            .unwrap_or_else(|| "New thread".to_owned());
        let title = title.trim().chars().take(128).collect::<String>();
        if title.is_empty() {
            self.thread_name_sync = Some(current);
            cx.notify();
            return;
        }
        if title == current {
            return;
        }
        if let Some(thread) = self.selected_thread.as_mut() {
            thread.title = title.clone();
        }
        if let Some(summary) = self.summaries.iter_mut().find(|thread| thread.id == id) {
            summary.display_title = Some(title.clone());
        }
        self.thread_name_sync = Some(title.clone());
        self.request_mutation(
            "renameThread",
            json!({"threadId": id, "title": title}),
            "Thread rename",
            cx,
        );
    }

    fn answer_permission(
        &mut self,
        session_id: Option<String>,
        request_id: String,
        option_id: Option<String>,
        cx: &mut Context<Self>,
    ) {
        match self
            .acp
            .answer_permission(session_id, request_id, option_id)
        {
            Ok(()) => {
                self.permission = None;
                self.notice = Some("Permission response sent".to_string());
            }
            Err(error) => self.notice = Some(error),
        }
        cx.notify();
    }

    fn handle_shell_action(
        &mut self,
        action: ShellAction,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        match action {
            ShellAction::Search => self.search.read(cx).focus_handle(cx).focus(window, cx),
            ShellAction::NewThread => self.create_thread(cx),
            ShellAction::ToggleSidebar => self.sidebar_collapsed = !self.sidebar_collapsed,
            ShellAction::ToggleNavIcons => self.nav_icons = !self.nav_icons,
            ShellAction::ToggleNavMore => self.nav_more = !self.nav_more,
            ShellAction::SelectMode(mode) => self.mode = mode,
            ShellAction::SelectProject(_) => self.mode = WorkspaceMode::Threads,
            ShellAction::ConnectProject => {
                self.notice = Some("Folder connection is not available yet".to_string())
            }
            ShellAction::SelectThread(id) => self.select_thread(id.to_string(), cx),
            ShellAction::ArchiveThread(id) => self.request_mutation(
                "setThreadArchived",
                json!({"threadId": id.to_string(), "archived": "true"}),
                "Thread archive",
                cx,
            ),
            ShellAction::RenameThread(id) => self.begin_thread_rename(id.to_string()),
            ShellAction::CancelRenameThread => self.renaming_thread = None,
            ShellAction::SelectInspectorTab(tab) => {
                self.inspector_tab = tab;
            }
            ShellAction::BeginResize(pane) => self.resize_pane = Some(pane),
            ShellAction::ResizeBy(pane, delta) => {
                resize_pane_layout(&mut self.pane_layout, pane, delta);
                self.resize_pane = Some(pane);
            }
            ShellAction::ResizeTo(pane, position) => {
                resize_pane_to(
                    &mut self.pane_layout,
                    pane,
                    position,
                    window.viewport_size(),
                );
                self.resize_pane = Some(pane);
            }
            ShellAction::EndResize => self.resize_pane = None,
        }
        cx.notify();
    }

    fn render_mode(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let content = match self.mode {
            WorkspaceMode::Threads => self.render_content(cx).into_any_element(),
            WorkspaceMode::Knowledge => self.render_workspace_page(
                WorkspacePage::Knowledge(self.knowledge_page.clone()),
                &theme,
            ),
            WorkspaceMode::Artifacts => self.render_workspace_page(
                WorkspacePage::Artifacts(self.artifacts_page.clone()),
                &theme,
            ),
            WorkspaceMode::Agent => {
                self.render_workspace_page(WorkspacePage::Agent(self.agent_page.clone()), &theme)
            }
            WorkspaceMode::Scheduled => self.render_workspace_page(
                WorkspacePage::Scheduled(self.scheduled_page.clone()),
                &theme,
            ),
            WorkspaceMode::Plugins => self
                .render_workspace_page(WorkspacePage::Plugins(self.plugins_page.clone()), &theme),
            WorkspaceMode::Research => self
                .render_workspace_page(WorkspacePage::Research(self.research_page.clone()), &theme),
            WorkspaceMode::Archive => self
                .render_workspace_page(WorkspacePage::Archive(self.archive_page.clone()), &theme),
            WorkspaceMode::Settings => self.render_settings(window, cx),
        };
        if let Some(permission) = self.render_permission_prompt(cx) {
            v_flex()
                .size_full()
                .child(permission)
                .child(content)
                .into_any_element()
        } else {
            content
        }
    }

    fn render_workspace_page(&self, page: WorkspacePage, theme: &EmmaTheme) -> gpui::AnyElement {
        let actions = self.workspace_actions.clone();
        let callbacks = WorkspacePageCallbacks::new(move |action| {
            let _ = actions.try_send(action);
        });
        page.render_with_inputs(theme, callbacks, &self.workspace_inputs)
            .into_any_element()
    }

    fn render_settings(&self, window: &mut Window, cx: &mut Context<Self>) -> gpui::AnyElement {
        let page = SettingsPageId::from_id(&self.settings_page).unwrap_or(SettingsPageId::Keybinds);
        let view = cx.entity();
        div()
            .size_full()
            .child(
                SettingsPages::new(page, self.settings_state.clone())
                    .inputs(self.settings_inputs.clone())
                    .setup(self.settings_setup.clone())
                    .setup_focus(self.settings_focus.clone())
                    .on_action(move |action, window, app| {
                        view.update(app, |this, cx| {
                            this.handle_settings_action(action, window, cx)
                        });
                    })
                    .render(window, cx),
            )
            .into_any_element()
    }

    fn render_permission_prompt(&self, cx: &mut Context<Self>) -> Option<Div> {
        let prompt = self.permission.as_ref()?;
        let thread_label = prompt.thread_id.as_deref().unwrap_or("agent session");
        let request_id = prompt.request_id.clone();
        let session_id = prompt.session_id.clone();
        let mut options = v_flex().gap_2();
        for option in &prompt.options {
            let option_id = option.option_id.clone();
            let request_id = request_id.clone();
            let session_id = session_id.clone();
            let label = option.name.clone();
            let accessibility = format!("{} ({})", option.name, option.kind);
            options = options.child(
                Button::new(format!("permission-{request_id}-{option_id}"))
                    .primary()
                    .label(label)
                    .accessibility_label(accessibility)
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.answer_permission(
                            session_id.clone(),
                            request_id.clone(),
                            Some(option_id.clone()),
                            cx,
                        );
                    })),
            );
        }
        let deny_request = request_id.clone();
        let deny_session = session_id.clone();
        let has_deny = prompt.options.iter().any(|option| {
            let option_id = option.option_id.to_ascii_lowercase();
            let kind = option.kind.to_ascii_lowercase();
            option_id.contains("reject")
                || option_id.contains("deny")
                || kind.contains("reject")
                || kind.contains("deny")
        });
        if !has_deny {
            options = options.child(
                Button::new(format!("permission-deny-{request_id}"))
                    .danger()
                    .label("Deny")
                    .accessibility_label("Deny this permission request")
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.answer_permission(
                            deny_session.clone(),
                            deny_request.clone(),
                            None,
                            cx,
                        );
                    })),
            );
        }
        Some(
            v_flex()
                .gap_2()
                .p_4()
                .border_b_1()
                .border_color(cx.theme().border)
                .bg(cx.theme().popover)
                .text_color(cx.theme().popover_foreground)
                .child(div().font_bold().child(prompt.title.clone()))
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!("Permission requested for {thread_label}")),
                )
                .child(
                    div()
                        .text_sm()
                        .text_color(cx.theme().muted_foreground)
                        .child(format!(
                            "Permission mode: {}",
                            prompt.permission_mode.as_deref().unwrap_or("ask")
                        )),
                )
                .child(options),
        )
    }

    fn render_inspector(&self, cx: &mut Context<Self>) -> Div {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let mut body = v_flex()
            .size_full()
            .gap_3()
            .p_4()
            .bg(theme.colors.surface)
            .text_color(theme.colors.text);
        if let Some(thread) = self.selected_thread.as_ref() {
            body = body
                .child(div().font_bold().child(thread.title.clone()))
                .child(
                    div()
                        .text_sm()
                        .text_color(theme.colors.text_3)
                        .child(format!("{} messages", thread.messages.len())),
                );
        } else {
            body = body.child(
                div()
                    .text_color(theme.colors.text_3)
                    .child("No thread selected"),
            );
        }
        body.child(
            div()
                .text_sm()
                .text_color(theme.colors.text_3)
                .child(format!("Mode: {}", self.mode.label())),
        )
    }

    fn render_shell(&self, window: &mut Window, cx: &mut Context<Self>) -> WorkspaceShell {
        let view = cx.entity();
        let query = self.search.read(cx).value().trim().to_ascii_lowercase();
        let threads = self
            .summaries
            .iter()
            .filter(|summary| {
                query.is_empty()
                    || summary.title.to_ascii_lowercase().contains(&query)
                    || summary.id.to_ascii_lowercase().contains(&query)
            })
            .map(|summary| {
                let id = summary.id.clone();
                let label = summary
                    .display_title
                    .clone()
                    .unwrap_or_else(|| summary.title.clone());
                let status = if self
                    .streaming
                    .as_ref()
                    .is_some_and(|turn| turn.thread_id == summary.id)
                {
                    ShellStatus::Running
                } else {
                    ShellStatus::Idle
                };
                ShellRow::new(id, label)
                    .tag(summary.messages.to_string())
                    .status(status)
                    .selected(self.selected_id.as_deref() == Some(summary.id.as_str()))
            })
            .collect::<Vec<_>>();
        let project = ShellProject::new("workspace", "WORKSPACE")
            .count(self.summaries.len().to_string())
            .threads(threads)
            .selected(true);
        let browser_visible = self.mode == WorkspaceMode::Threads
            && self.selected_thread.is_some()
            && self.pane_layout.browser_open;
        let browser = browser_visible
            .then(|| {
                self.selected_id
                    .as_ref()
                    .and_then(|id| self.browser_sessions.get(id))
                    .map(|session| {
                        let browser_view = view.clone();
                        BrowserPaneView::new(session.pane.clone())
                            .frame(session.surface.clone())
                            .address_input(self.browser_input.clone())
                            .on_action(move |action, window, app| {
                                browser_view.update(app, |this, cx| {
                                    this.handle_browser_action(action, window, cx)
                                });
                            })
                    })
            })
            .flatten();
        let status = if self.permission.is_some() {
            "Permission required"
        } else if self.streaming.is_some() {
            "Emma is working"
        } else {
            "Agent ready"
        };
        let mut shell = WorkspaceShell::new(self.render_mode(window, cx))
            .search_state(&self.search)
            .active_mode(self.mode)
            .selected_project("workspace")
            .sidebar_collapsed(self.sidebar_collapsed)
            .sidebar_width(px(self.pane_layout.sidebar_width))
            .inspector_width(px(self.pane_layout.inspector_width))
            .rename_state(self.renaming_thread.clone(), &self.rename_input)
            .nav_icons(self.nav_icons)
            .nav_more(self.nav_more)
            .nav_order(WorkspaceMode::NAV)
            .nav_count(WorkspaceMode::Threads, self.summaries.len().to_string())
            .projects([project])
            .status_label(status)
            .inspector_tab(self.inspector_tab)
            .inspector(self.render_inspector(cx))
            .inspector_visible(
                self.selected_thread.is_some() && !self.pane_layout.inspector_collapsed,
            )
            .terminal(self.terminal.clone())
            .terminal_height(px(self.pane_layout.terminal_height))
            .resizing_pane(self.resize_pane)
            .terminal_visible(
                self.mode == WorkspaceMode::Threads
                    && self.selected_thread.is_some()
                    && self.pane_layout.terminal_open,
            );
        if let Some(browser) = browser {
            shell = shell.browser(browser);
        }
        shell
            .browser_visible(browser_visible)
            .browser_width(px(self.pane_layout.browser_width))
            .on_action(move |action, window, app| {
                view.update(app, |this, cx| this.handle_shell_action(action, window, cx));
            })
    }

    fn render_content(&self, cx: &mut Context<Self>) -> Div {
        let body = match &self.state {
            LoadState::Loading => v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .child("Loading Emma…"),
            LoadState::Empty => v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .child("No threads yet")
                .child(
                    Button::new("empty-new-thread")
                        .primary()
                        .label("Create a thread")
                        .on_click(cx.listener(|this, _, _, cx| this.create_thread(cx))),
                ),
            LoadState::Failed(error) => v_flex()
                .size_full()
                .items_center()
                .justify_center()
                .gap_2()
                .child("Emma could not load this workspace")
                .child(div().text_sm().child(error.clone())),
            LoadState::Ready => self.render_thread(cx),
        };
        let mut content = v_flex()
            .h_full()
            .flex_1()
            .min_w_0()
            .bg(cx.theme().background)
            .text_color(cx.theme().foreground);
        if let Some(notice) = self.notice.as_ref() {
            content = content.child(
                div()
                    .p_2()
                    .text_sm()
                    .text_color(cx.theme().muted_foreground)
                    .child(notice.clone()),
            );
        }
        content.child(body)
    }

    fn conversation_page(&self, cx: &mut Context<Self>) -> ConversationPage {
        let mut page = match self.selected_thread.as_ref() {
            Some(thread) => {
                let entries = thread
                    .messages
                    .iter()
                    .enumerate()
                    .map(|(index, message)| {
                        let role = conversation_role(&message.role);
                        let mut item = ConversationMessage::new(
                            format!("{}-{index}", thread.id),
                            role,
                            message.content.clone(),
                            String::new(),
                        );
                        if let Some(generation) = &message.generation {
                            item.generation = Some(GenerationMeta {
                                model: generation.model.clone(),
                                ..GenerationMeta::default()
                            });
                        }
                        ConversationEntry::Message(item)
                    })
                    .collect::<Vec<_>>();
                ConversationPage::ready(thread.id.clone(), thread.title.clone(), entries)
            }
            None => ConversationPage {
                thread_id: self.selected_id.clone().unwrap_or_default(),
                thread_title: "New thread".to_string(),
                load_state: match &self.state {
                    LoadState::Loading => ConversationLoadState::Loading,
                    LoadState::Ready => ConversationLoadState::Empty,
                    LoadState::Empty => ConversationLoadState::Empty,
                    LoadState::Failed(error) => ConversationLoadState::Error(error.clone()),
                },
                ..ConversationPage::default()
            },
        };
        let composer_text = self.composer.read(cx).value().to_string();
        let model_id = self.selected_model.clone().unwrap_or_default();
        let model_label = if model_id.is_empty() {
            "Select model".to_string()
        } else {
            model_id.clone()
        };
        page.composer = ComposerState {
            text: composer_text.clone(),
            caret: composer_text.chars().count(),
            selection_end: composer_text.chars().count(),
            composing: self.composer_composing,
            mode: conversation_permission(&self.permission_mode),
            model: ModelChoice {
                id: model_id.clone(),
                label: model_label,
                brand: None,
                route: None,
                effort: None,
            },
            source_label: self.selected_source.clone(),
            sources: Vec::<SourceOption>::new(),
            capabilities: Vec::<SourceOption>::new(),
            models: model_id.is_empty().then(Vec::new).unwrap_or_else(|| {
                vec![ModelChoice {
                    id: model_id.clone(),
                    label: model_id.clone(),
                    brand: None,
                    route: None,
                    effort: None,
                }]
            }),
            locked: self.streaming.is_some(),
            mode_open: self.mode_menu_open,
            sources_open: self.sources_open,
            models_open: self.models_menu_open,
            capabilities_open: self.capabilities_open,
            stop_confirmation: self.stop_confirmation,
            ..ComposerState::default()
        };
        page.composer.text = composer_text;
        page.composer.completion = completion_menu_for(
            &page.composer.text,
            self.completion_dismissed,
            self.completion_active,
        );
        page.run.queued = self.queued_turns.clone();
        page.run.held = self.held_turns.clone();
        page.run.stop_confirmation = self.stop_confirmation;
        page.scroll.at_end = self.transcript_at_end;
        page.expanded_thinking = self.expanded_thinking.clone();
        page.expanded_tools = self.expanded_tools.clone();
        page.expanded_steps = self.expanded_steps.clone();
        page.terminal_open = self.pane_layout.terminal_open;
        page.browser_open = self.pane_layout.browser_open;
        page.inspector_open = !self.pane_layout.inspector_collapsed;
        if let Some(turn) = self.streaming.as_ref() {
            if self.selected_id.as_deref() == Some(turn.thread_id.as_str()) {
                page.entries
                    .push(ConversationEntry::Message(ConversationMessage::new(
                        format!("{}-stream-user", turn.thread_id),
                        ConversationRole::User,
                        turn.prompt.clone(),
                        String::new(),
                    )));
                page.run.state = if self.permission.is_some() {
                    RunState::Waiting
                } else {
                    RunState::Streaming
                };
                page.run.activity = if turn.thought.trim().is_empty() {
                    "Emma is thinking…".to_string()
                } else {
                    turn.thought.clone()
                };
                page.run.quiet_ms = turn.started_at.elapsed().as_millis() as u64;
                page.run.since_ms = 0;
                page.run.blocks = vec![
                    (!turn.thought.is_empty()).then(|| {
                        conversation::ConversationBlock::Thinking(ThinkingBlock {
                            id: format!("{}-thought", turn.thread_id),
                            text: turn.thought.clone(),
                            duration_ms: turn.started_at.elapsed().as_millis() as u64,
                            tokens: 0,
                            live: Some(turn.thought.clone()),
                        })
                    }),
                    Some(conversation::ConversationBlock::Markdown {
                        id: format!("{}-response", turn.thread_id),
                        text: turn.response.clone(),
                    }),
                ]
                .into_iter()
                .flatten()
                .collect();
                page.run.working_call = self.permission.is_some();
            }
        } else if self.notice.is_some() {
            page.run.state = RunState::Failed;
            page.run.error = self.notice.clone();
        }
        page
    }

    fn render_thread(&self, cx: &mut Context<Self>) -> Div {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let actions = self.conversation_actions.clone();
        let callbacks = ConversationCallbacks::new(move |action| {
            let _ = actions.try_send(action);
        });
        self.conversation_page(cx).render(
            &theme,
            callbacks,
            Some(&self.composer),
            Some(&self.thread_name),
        )
    }

    fn apply_deferred_inputs(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.clear_composer {
            self.composer
                .update(cx, |state, cx| state.set_value("", window, cx));
            self.clear_composer = false;
        }
        if let Some(value) = self.composer_replacement.take() {
            self.composer
                .update(cx, |state, cx| state.set_value(value, window, cx));
        }
        if let Some(draft) = self.scheduled_input_sync.take() {
            set_scheduled_input_values(&self.workspace_inputs, &draft, window, cx);
        }
        if let Some(form) = self.research_input_sync.take() {
            set_research_input_values(&self.workspace_inputs, &form, window, cx);
        }
        if let Some(value) = self.rename_input_sync.take() {
            self.rename_input
                .update(cx, |state, cx| state.set_value(value, window, cx));
            self.rename_input
                .read(cx)
                .focus_handle(cx)
                .focus(window, cx);
        }
        if let Some(value) = self.thread_name_sync.take() {
            self.thread_name
                .update(cx, |state, cx| state.set_value(value, window, cx));
        }
        if let Some(value) = self.browser_address_sync.take() {
            self.browser_input
                .update(cx, |state, cx| state.set_value(value, window, cx));
            self.browser_input
                .read(cx)
                .focus_handle(cx)
                .focus(window, cx);
        }
    }
}

impl Render for Workspace {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.apply_deferred_inputs(window, cx);
        self.sync_browser(window, cx);
        self.render_shell(window, cx)
    }
}

fn add_settings_single(
    inputs: &mut SettingsInputs,
    entities: &mut Vec<(InputId, Entity<InputState>)>,
    id: InputId,
    value: &str,
    placeholder: &str,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let state = cx.new(|cx| {
        InputState::new(window, cx)
            .default_value(value)
            .placeholder(placeholder)
    });
    *inputs = inputs.clone().single(id, state.clone());
    entities.push((id, state));
}

fn add_settings_multiline(
    inputs: &mut SettingsInputs,
    entities: &mut Vec<(InputId, Entity<TextareaState>)>,
    id: InputId,
    value: &str,
    placeholder: &str,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    let state = cx.new(|cx| {
        TextareaState::new(window, cx)
            .default_value(value)
            .placeholder(placeholder)
    });
    *inputs = inputs.clone().multiline(id, state.clone());
    entities.push((id, state));
}

type SettingsInputEntities = (
    SettingsInputs,
    Vec<(InputId, Entity<InputState>)>,
    Vec<(InputId, Entity<TextareaState>)>,
);

fn build_settings_inputs(
    window: &mut Window,
    cx: &mut Context<Workspace>,
) -> SettingsInputEntities {
    let mut inputs = SettingsInputs::default();
    let mut single = Vec::new();
    let mut multiline = Vec::new();
    for index in 0..4 {
        add_settings_single(
            &mut inputs,
            &mut single,
            InputId::QuickActionLabel(index),
            "",
            "Quick action label",
            window,
            cx,
        );
        add_settings_multiline(
            &mut inputs,
            &mut multiline,
            InputId::QuickActionPrompt(index),
            "",
            "Quick action prompt",
            window,
            cx,
        );
        add_settings_single(
            &mut inputs,
            &mut single,
            InputId::PromptName(index as u16),
            "",
            "Prompt name",
            window,
            cx,
        );
        add_settings_multiline(
            &mut inputs,
            &mut multiline,
            InputId::PromptBody(index as u16),
            "",
            "Prompt body",
            window,
            cx,
        );
        add_settings_single(
            &mut inputs,
            &mut single,
            InputId::Credential(index as u16),
            "",
            "API key",
            window,
            cx,
        );
        add_settings_single(
            &mut inputs,
            &mut single,
            InputId::SearchEndpoint(index as u16),
            "",
            "Search endpoint",
            window,
            cx,
        );
        add_settings_single(
            &mut inputs,
            &mut single,
            InputId::SearchCredential(index as u16),
            "",
            "Search credential",
            window,
            cx,
        );
        for variable in 0..4 {
            add_settings_single(
                &mut inputs,
                &mut single,
                InputId::BuiltVariable(index as u16, variable as u16),
                "",
                "Leave empty to clear",
                window,
                cx,
            );
        }
    }
    for (id, value, placeholder) in [
        (InputId::VoiceEndpoint, "", "Speech endpoint"),
        (InputId::VoiceModel, "", "Speech model"),
        (InputId::CleanupEndpoint, "", "Cleanup endpoint"),
        (InputId::CleanupModel, "", "Cleanup model"),
        (InputId::NotchGap, "120", "Fallback gap"),
        (InputId::ModelsSearch, "", "Search models by name or ID"),
        (InputId::ProviderName, "", "Provider name"),
        (InputId::ProviderBaseUrl, "", "Provider base URL"),
        (InputId::ProviderModelId, "", "Provider model ID"),
        (
            InputId::ProviderCredentialEnv,
            "",
            "Credential environment variable",
        ),
        (InputId::ProviderContextWindow, "", "Context window"),
        (
            InputId::CustomCredentialEnv,
            "",
            "Environment variable name",
        ),
        (InputId::MobilePin, "", "Six digits"),
        (InputId::VaultFolder, "Emma", "Vault folder"),
    ] {
        add_settings_single(&mut inputs, &mut single, id, value, placeholder, window, cx);
    }
    for (id, value, placeholder) in [
        (InputId::SystemPrompt, "", "Global system prompt"),
        (InputId::VerifierRules, "", "Verifier rules"),
        (InputId::AdvisorRules, "", "Advisor rules"),
        (InputId::VisionRules, "", "Vision rules"),
        (InputId::SecretRules, "", "Secret rules"),
    ] {
        add_settings_multiline(
            &mut inputs,
            &mut multiline,
            id,
            value,
            placeholder,
            window,
            cx,
        );
    }
    (inputs, single, multiline)
}

fn default_settings_state(model: &str, permission_mode: &str) -> SettingsState {
    SettingsState {
        platform: settings_pages::Platform::MacOS,
        status: settings_pages::SettingsAsyncState::Ready,
        validation: settings_pages::ValidationState::Valid,
        disabled: false,
        page: settings_page_state(SettingsPageId::Keybinds, model, permission_mode),
    }
}

fn settings_page_state(
    page: SettingsPageId,
    model: &str,
    permission_mode: &str,
) -> settings_pages::SettingsPageState {
    use settings_pages::{
        AboutPageState, AppearancePageState, BuiltPageState, ContextBarPageState, CursorOrbState,
        FontChoice, HarnessPageState, ImportsPageState, KeybindsPageState, MobilePageState,
        ModelsPageState, NotchConcurrency, NotchPageState, PermissionsPageState, PrivacyPageState,
        PromptsPageState, ToolsPageState, VerifierPageState, VoicePageState,
    };
    match page {
        SettingsPageId::Keybinds => {
            settings_pages::SettingsPageState::Keybinds(KeybindsPageState {
                shortcuts: Vec::new(),
                bound: 0,
                quick_actions: vec![
                    settings_pages::QuickActionState {
                        label: "Ask Emma".into(),
                        prompt: "".into(),
                    };
                    4
                ],
                orbs: CursorOrbState {
                    enabled: true,
                    commands_enabled: true,
                    commands: Vec::new(),
                    selected: 0,
                },
                saved: false,
            })
        }
        SettingsPageId::Notch => settings_pages::SettingsPageState::Notch(NotchPageState {
            model: model.into(),
            concurrency: NotchConcurrency::Separate,
            notch_gap: 120,
        }),
        SettingsPageId::Voice => settings_pages::SettingsPageState::Voice(VoicePageState {
            microphone: settings_pages::PermissionStatus::Unknown,
            speech_ready: false,
            speech_error: None,
            cleanup_running: false,
            cleanup_model_loaded: false,
            transcription_enabled: false,
            engine: settings_pages::TranscriptionEngine::Apple,
            hold_ms: 500,
            cleanup_enabled: false,
            serving_models: Vec::new(),
            heard: None,
        }),
        SettingsPageId::Appearance => {
            settings_pages::SettingsPageState::Appearance(AppearancePageState {
                accent: settings_pages::AccentChoice::Orange,
                ui_scale: 100,
                conversation_width: settings_pages::ConversationWidth::Default,
                nav_icon_colors: true,
                nav_hues: Vec::new(),
                interface_font: FontChoice::Inter,
                agent_font: FontChoice::Inter,
            })
        }
        SettingsPageId::ContextBar => {
            settings_pages::SettingsPageState::ContextBar(ContextBarPageState {
                pages: Vec::new(),
                active: 0,
            })
        }
        SettingsPageId::Models => settings_pages::SettingsPageState::Models(ModelsPageState {
            catalog: if model.is_empty() {
                Vec::new()
            } else {
                vec![settings_pages::ModelOption {
                    id: model.into(),
                    name: model.into(),
                    detail: "Configured model".into(),
                    maker: "Configured".into(),
                    free: false,
                    active: true,
                    starred: false,
                    accepts_images: false,
                }]
            },
            selected_model: model.into(),
            providers: Vec::new(),
            verifier: VerifierPageState {
                model: "".into(),
                endpoint: "".into(),
                credential_env: "".into(),
                configured: false,
                system_chars: 0,
            },
            advisor: VerifierPageState {
                model: "".into(),
                endpoint: "".into(),
                credential_env: "".into(),
                configured: false,
                system_chars: 0,
            },
            vision: VerifierPageState {
                model: "".into(),
                endpoint: "".into(),
                credential_env: "".into(),
                configured: false,
                system_chars: 0,
            },
            secret: VerifierPageState {
                model: "".into(),
                endpoint: "".into(),
                credential_env: "".into(),
                configured: false,
                system_chars: 0,
            },
            credentials: Vec::new(),
            require_zero_retention: false,
            transcription_enabled: false,
            catalog_status: settings_pages::SettingsAsyncState::Ready,
        }),
        SettingsPageId::Prompts => settings_pages::SettingsPageState::Prompts(PromptsPageState {
            global_chars: 0,
            presets: Vec::new(),
            maximum: 65_536,
            system_status: settings_pages::SettingsAsyncState::Ready,
        }),
        SettingsPageId::Tools => settings_pages::SettingsPageState::Tools(ToolsPageState {
            default_mode: settings_permission(permission_mode),
            tools: Vec::new(),
            search: Vec::new(),
            written: Vec::new(),
            skills: Vec::new(),
            servers: Vec::new(),
        }),
        SettingsPageId::Permissions => {
            settings_pages::SettingsPageState::Permissions(PermissionsPageState {
                grants: Vec::new(),
            })
        }
        SettingsPageId::Harness => settings_pages::SettingsPageState::Harness(HarnessPageState {
            reinject_steps: 8,
            reinject_percent: 75,
            prune_steps: 12,
            prune_percent: 60,
            auto_compact_percent: 80,
        }),
        SettingsPageId::Imports => settings_pages::SettingsPageState::Imports(ImportsPageState {
            sources: Vec::new(),
            scan_status: settings_pages::SettingsAsyncState::Idle,
            import_status: settings_pages::SettingsAsyncState::Idle,
        }),
        SettingsPageId::Mobile => settings_pages::SettingsPageState::Mobile(MobilePageState {
            pin_ready: false,
            pairing: false,
            pairing_code: None,
            expires_in: None,
            devices: Vec::new(),
            listening: false,
            address: None,
            full: false,
        }),
        SettingsPageId::Built => {
            settings_pages::SettingsPageState::Built(BuiltPageState { cards: Vec::new() })
        }
        SettingsPageId::Privacy => settings_pages::SettingsPageState::Privacy(PrivacyPageState {
            reset_confirmation: false,
            openrouter_url: "https://openrouter.ai/settings/privacy".into(),
        }),
        SettingsPageId::About => settings_pages::SettingsPageState::About(AboutPageState {
            credits: Vec::new(),
        }),
    }
}

fn default_setup_state(model: Option<&str>) -> SetupState {
    SetupState {
        open: false,
        step: SetupStep::Emma,
        status: settings_pages::SettingsAsyncState::Idle,
        permissions: Vec::new(),
        openrouter_saved: false,
        openrouter_masked: None,
        balance: None,
        selected_model: model.unwrap_or_default().into(),
        model_options: Vec::new(),
        quick_ask_tapped: false,
        vault: None,
        detected_vaults: Vec::new(),
        selected_imports: Vec::new(),
        import_sources: Vec::new(),
    }
}

fn settings_permission(value: &str) -> settings_pages::PermissionMode {
    match value {
        "plan" => settings_pages::PermissionMode::Plan,
        "auto" => settings_pages::PermissionMode::Auto,
        "full" => settings_pages::PermissionMode::Full,
        _ => settings_pages::PermissionMode::Ask,
    }
}

fn settings_permission_id(value: settings_pages::PermissionMode) -> &'static str {
    match value {
        settings_pages::PermissionMode::Plan => "plan",
        settings_pages::PermissionMode::Ask => "ask",
        settings_pages::PermissionMode::Auto => "auto",
        settings_pages::PermissionMode::Full => "full",
    }
}

fn conversation_permission(value: &str) -> PermissionMode {
    match value {
        "acceptEdits" => PermissionMode::AcceptEdits,
        "auto" => PermissionMode::Auto,
        "full" => PermissionMode::Full,
        _ => PermissionMode::Ask,
    }
}

fn conversation_permission_id(value: PermissionMode) -> &'static str {
    match value {
        PermissionMode::Ask => "ask",
        PermissionMode::AcceptEdits => "acceptEdits",
        PermissionMode::Auto => "auto",
        PermissionMode::Full => "full",
    }
}

fn host_permission_mode(value: &str) -> &'static str {
    match value {
        "acceptEdits" => "acceptEdits",
        "full" => "full",
        _ => "ask",
    }
}

fn conversation_role(value: &str) -> ConversationRole {
    match value {
        "user" => ConversationRole::User,
        "system" => ConversationRole::System,
        _ => ConversationRole::Assistant,
    }
}

fn replace_active_completion(text: &str, id: &str) -> String {
    let start = text
        .char_indices()
        .rev()
        .find(|(_, character)| character.is_whitespace())
        .map_or(0, |(index, character)| index + character.len_utf8());
    let token = &text[start..];
    let sigil = token
        .chars()
        .next()
        .filter(|character| *character == '/' || *character == '@');
    let replacement = sigil.map_or_else(|| id.to_string(), |character| format!("{character}{id}"));
    format!("{}{} ", &text[..start], replacement)
}

fn completion_menu_for(text: &str, dismissed: bool, active: usize) -> Option<CompletionMenu> {
    if dismissed {
        return None;
    }
    let start = text
        .char_indices()
        .rev()
        .find(|(_, character)| character.is_whitespace())
        .map_or(0, |(index, character)| index + character.len_utf8());
    if start > 0
        && !text[..start]
            .chars()
            .last()
            .is_some_and(char::is_whitespace)
    {
        return None;
    }
    let token = &text[start..];
    let (sigil, query) = match token.chars().next() {
        Some('/') => (CompletionSigil::Slash, &token['/'.len_utf8()..]),
        Some('@') => (CompletionSigil::At, &token['@'.len_utf8()..]),
        _ => return None,
    };
    if !query.chars().all(|character| {
        character.is_ascii_alphanumeric()
            || matches!(sigil, CompletionSigil::At) && "._:/-".contains(character)
            || matches!(sigil, CompletionSigil::Slash) && "._:-".contains(character)
    }) {
        return None;
    }
    let query_lower = query.to_ascii_lowercase();
    let items = match sigil {
        CompletionSigil::Slash => [
            ("agent", "built-in · Zig coding harness"),
            ("import", "built-in · import skills & MCP"),
            ("new", "built-in · new thread in this project"),
            ("clear", "built-in · empty the context window"),
        ]
        .into_iter()
        .filter(|(name, _)| name.contains(&query_lower))
        .map(|(name, detail)| CompletionItem {
            id: name.to_string(),
            name: name.to_string(),
            kind: CompletionKind::Builtin,
            detail: detail.to_string(),
        })
        .collect(),
        CompletionSigil::At => Vec::new(),
    };
    let active = if items.is_empty() {
        0
    } else {
        active % items.len()
    };
    Some(CompletionMenu {
        sigil,
        query: query.to_string(),
        items,
        active,
    })
}

fn move_completion(active: usize, count: usize, delta: isize) -> usize {
    if count == 0 {
        return 0;
    }
    let current = (active % count) as isize;
    (current + delta.rem_euclid(count as isize)).rem_euclid(count as isize) as usize
}

fn toggle_string(values: &mut Vec<String>, value: String) {
    if let Some(index) = values.iter().position(|item| item == &value) {
        values.remove(index);
    } else {
        values.push(value);
    }
}

fn resize_pane_layout(layout: &mut PaneLayout, pane: ShellPane, delta: i16) {
    let delta = f32::from(delta);
    match pane {
        ShellPane::Sidebar => layout.sidebar_width += delta,
        ShellPane::Inspector => layout.inspector_width -= delta,
        ShellPane::Browser => layout.browser_width -= delta,
        ShellPane::Terminal => layout.terminal_height += delta,
    }
    *layout = layout.clone().validated(f64::INFINITY);
}

fn resize_pane_to(
    layout: &mut PaneLayout,
    pane: ShellPane,
    position: i16,
    viewport: gpui::Size<gpui::Pixels>,
) {
    let position = f32::from(position);
    match pane {
        ShellPane::Sidebar => layout.sidebar_width = position,
        ShellPane::Inspector => layout.inspector_width = viewport.width.as_f32() - position,
        ShellPane::Browser => layout.browser_width = viewport.width.as_f32() - position,
        ShellPane::Terminal => layout.terminal_height = viewport.height.as_f32() - position,
    }
    *layout = layout.clone().validated(f64::from(viewport.width.as_f32()));
}

fn selected_research_job_id(page: &ResearchPage) -> Value {
    page.selected
        .as_ref()
        .map_or(Value::Null, |id| Value::String(id.clone()))
}

fn default_scheduled_draft() -> ScheduledDraft {
    ScheduledDraft {
        id: None,
        title: String::new(),
        model: String::new(),
        trigger: "manual".to_string(),
        prompt: String::new(),
        runs_as: "ask".to_string(),
        enabled: true,
    }
}

fn scheduled_surfaces(
    value: &Value,
    job: &ScheduledJob,
    permission_mode: &str,
) -> (ScheduledEditor, ScheduledGraph) {
    let prompt = value_text(value.get("prompt")).unwrap_or_default();
    let model = value_text(value.get("model")).unwrap_or_default();
    let runs_as =
        value_text(value.get("permissionMode")).unwrap_or_else(|| permission_mode.to_string());
    let raw_nodes = value_text(value.get("nodes")).unwrap_or_default();
    let steps = scheduled_steps(&raw_nodes, &prompt);
    let rows = steps
        .iter()
        .map(|step| vec![step.id.clone()])
        .collect::<Vec<_>>();
    let edges = steps
        .iter()
        .enumerate()
        .map(|(index, step)| ScheduledGraphEdge {
            from: step.id.clone(),
            to: steps
                .get(index + 1)
                .map_or_else(|| "end".to_string(), |next| next.id.clone()),
            label: None,
        })
        .collect::<Vec<_>>();
    let draft = ScheduledDraft {
        id: Some(job.id.clone()),
        title: job.title.clone(),
        model,
        trigger: job.trigger.clone(),
        prompt: prompt.clone(),
        runs_as,
        enabled: job.enabled,
    };
    let editor = ScheduledEditor {
        draft: draft.clone(),
        steps: steps.clone(),
        graph_error: None,
        runs: Vec::new(),
        variables: Vec::new(),
        dry_run: false,
    };
    let graph = ScheduledGraph {
        title: job.title.clone(),
        trigger: job.trigger.clone(),
        steps,
        rows,
        edges,
        selected_step: None,
        stdin: None,
        saves_as: None,
        goes_to: None,
    };
    (editor, graph)
}

fn scheduled_steps(nodes: &str, prompt: &str) -> Vec<ScheduledStep> {
    let candidates = serde_json::from_str::<Value>(nodes)
        .ok()
        .and_then(|value| match value {
            Value::Array(items) => Some(items),
            Value::Object(object) => object.get("nodes").and_then(Value::as_array).cloned(),
            _ => None,
        })
        .unwrap_or_default();
    if candidates.is_empty() {
        if prompt.trim().is_empty() {
            return Vec::new();
        }
        return vec![ScheduledStep {
            id: "prompt".to_string(),
            kind: "agent".to_string(),
            text: prompt.to_string(),
            details: None,
        }];
    }
    candidates
        .iter()
        .enumerate()
        .map(|(index, value)| {
            let id = value_text(value.get("id")).unwrap_or_else(|| format!("step-{}", index + 1));
            let kind = value_text(value.get("kind")).unwrap_or_else(|| "agent".to_string());
            let text = value_text(value.get("text"))
                .or_else(|| value_text(value.get("prompt")))
                .unwrap_or_default();
            let details = ["input", "saveAs", "next", "otherwise"]
                .iter()
                .filter_map(|key| value_text(value.get(*key)).map(|value| format!("{key} {value}")))
                .collect::<Vec<_>>();
            ScheduledStep {
                id,
                kind,
                text,
                details: (!details.is_empty()).then(|| details.join(" · ")),
            }
        })
        .collect()
}

fn valid_scheduled_draft(draft: &ScheduledDraft) -> bool {
    !draft.title.trim().is_empty()
        && !draft.trigger.trim().is_empty()
        && !draft.prompt.trim().is_empty()
}

fn scheduled_nodes_json(editor: &ScheduledEditor) -> String {
    let nodes = editor
        .steps
        .iter()
        .map(|step| {
            json!({
                "id": step.id,
                "kind": step.kind,
                "text": step.text,
            })
        })
        .collect::<Vec<_>>();
    serde_json::to_string(&nodes).unwrap_or_default()
}

fn set_scheduled_input_values(
    inputs: &WorkspacePageInputs,
    draft: &ScheduledDraft,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    if let Some(state) = inputs.scheduled.title.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(draft.title.clone(), window, cx)
        });
    }
    if let Some(state) = inputs.scheduled.model.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(draft.model.clone(), window, cx)
        });
    }
    if let Some(state) = inputs.scheduled.trigger.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(draft.trigger.clone(), window, cx)
        });
    }
    if let Some(state) = inputs.scheduled.prompt.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(draft.prompt.clone(), window, cx)
        });
    }
    if let Some(state) = inputs.scheduled.runs_as.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(draft.runs_as.clone(), window, cx)
        });
    }
}

fn set_research_input_values(
    inputs: &WorkspacePageInputs,
    form: &ResearchForm,
    window: &mut Window,
    cx: &mut Context<Workspace>,
) {
    if let Some(state) = inputs.research.title.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(form.title.clone(), window, cx)
        });
    }
    if let Some(state) = inputs.research.optimizing.as_ref() {
        state.update(cx, |state, cx| {
            state.set_value(form.optimizing.clone(), window, cx)
        });
    }
}

fn main() {
    gpui_platform::application()
        .with_assets(Assets)
        .run(move |cx| {
            gpui_component::init(cx);
            let theme = EmmaTheme::dark();
            let tokens = theme.component_tokens();
            theme.install(cx);
            gpui_component::Theme::global_mut(cx).apply_semantic_tokens(&tokens);
            gpui_component::Theme::sync_base(cx);
            let _ = cx
                .text_system()
                .add_fonts(vec![Cow::Borrowed(include_bytes!(concat!(
                    env!("CARGO_MANIFEST_DIR"),
                    "/../../desktop/assets/DepartureMono-Regular.woff2"
                )))]);
            cx.set_app_identity("com.tronschell.emma", "Emma");
            let platform = native_host_platform();
            let adapter = NativeWindowAdapter::new(platform);
            let display = adapter
                .primary_display(cx)
                .expect("Emma needs a display for its workspace window");
            let mut spec = NativeWindowSpec::workspace(display, platform, false);
            spec.flags.show = true;
            cx.spawn(async move |cx| {
                cx.update(|cx| {
                    let mut controller = NativeWindowController::new(platform);
                    controller
                        .open_with_root(cx, spec, |window, cx| {
                            let view = cx.new(|cx| Workspace::new(window, cx));
                            cx.new(|cx| Root::new(view, window, cx))
                        })
                        .expect("could not open Emma window");
                    adapter
                        .configure(NativeWindowRole::Workspace, &controller, cx)
                        .expect("could not configure Emma's native workspace window");
                });
            })
            .detach();
        });
}

const fn native_host_platform() -> NativeHostPlatform {
    #[cfg(target_os = "macos")]
    {
        NativeHostPlatform::MacOS
    }
    #[cfg(target_os = "windows")]
    {
        NativeHostPlatform::Windows
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        NativeHostPlatform::Other
    }
}

fn recorded_turn_params(
    thread_id: &str,
    prompt: &str,
    thinking: &str,
    answer: &str,
    usage: &crate::acp::AcpUsage,
    duration: std::time::Duration,
    model: Option<&str>,
) -> Value {
    let mut room = MAX_RECORDED_TURN_BYTES;
    loop {
        let prompt = elide_text(prompt, room);
        let thinking = elide_text(thinking, room);
        let answer = elide_text(answer, room);
        let response = with_thinking(&thinking, &answer);
        let params = json!({
            "threadId": thread_id,
            "prompt": prompt,
            "response": response,
            "outputTokens": usage.output_tokens.to_string(),
            "durationMilliseconds": duration.as_millis().max(1).to_string(),
            "inputTokens": usage.input_tokens.to_string(),
            "cacheInputTokens": usage.cache_input_tokens.map(|value| value.to_string()),
            "cacheReadTokens": usage.cache_read_tokens.map(|value| value.to_string()),
            "cacheWriteTokens": usage.cache_write_tokens.map(|value| value.to_string()),
            "costMicroUsd": usage.cost_micro_usd.map(|value| value.to_string()),
            "model": model.unwrap_or_default()
        });
        let size = serde_json::to_vec(&params).map_or(usize::MAX, |bytes| bytes.len());
        if size <= MAX_RECORDED_TURN_BYTES || room <= MIN_RECORDED_TURN_ROOM {
            return params;
        }
        let next = room
            .saturating_mul(MAX_RECORDED_TURN_BYTES)
            .checked_div(size)
            .unwrap_or(MIN_RECORDED_TURN_ROOM);
        room = next.max(MIN_RECORDED_TURN_ROOM).min(room.saturating_sub(1));
    }
}

fn with_thinking(thinking: &str, answer: &str) -> String {
    let thinking = thinking.trim();
    if thinking.is_empty() {
        answer.to_string()
    } else {
        format!("<think>{thinking}</think>\n{answer}")
    }
}

fn elide_text(text: &str, room: usize) -> String {
    if text.len() <= room {
        return text.to_string();
    }
    let mut head_budget = room.saturating_sub(48) / 2;
    let mut tail_budget = room.saturating_sub(48).saturating_sub(head_budget);
    loop {
        let head = prefix_bytes(text, head_budget);
        let tail = suffix_bytes(text, tail_budget);
        let omitted = text
            .chars()
            .count()
            .saturating_sub(head.chars().count().saturating_add(tail.chars().count()));
        let marker = format!("\n\n… {omitted} characters elided …\n\n");
        let size = head
            .len()
            .saturating_add(marker.len())
            .saturating_add(tail.len());
        if size <= room {
            return format!("{head}{marker}{tail}");
        }
        if head_budget >= tail_budget && head_budget > 0 {
            head_budget = head_budget.saturating_sub(size.saturating_sub(room).max(1));
        } else if tail_budget > 0 {
            tail_budget = tail_budget.saturating_sub(size.saturating_sub(room).max(1));
        } else {
            return prefix_bytes(text, room).to_string();
        }
    }
}

fn prefix_bytes(text: &str, max_bytes: usize) -> &str {
    let end = max_bytes.min(text.len());
    let mut end = end;
    while end > 0 && !text.is_char_boundary(end) {
        end -= 1;
    }
    &text[..end]
}

fn suffix_bytes(text: &str, max_bytes: usize) -> &str {
    let start = text.len().saturating_sub(max_bytes);
    let mut start = start;
    while start < text.len() && !text.is_char_boundary(start) {
        start += 1;
    }
    &text[start..]
}

fn parse_scheduled_job(value: &Value) -> Option<ScheduledJob> {
    let id = value_text(value.get("id"))?;
    let title = value_text(value.get("title")).unwrap_or_else(|| "Scheduled task".to_string());
    let trigger = value_text(value.get("schedule"))
        .or_else(|| value_text(value.get("trigger")))
        .unwrap_or_else(|| "manual".to_string());
    let nodes = value_text(value.get("nodes")).unwrap_or_default();
    let step_count = nodes.lines().filter(|line| !line.trim().is_empty()).count();
    Some(ScheduledJob {
        id,
        title,
        trigger,
        enabled: value
            .get("enabled")
            .and_then(Value::as_bool)
            .unwrap_or(true),
        next_run: value_optional_text(value.get("nextRunAt")),
        step_count,
    })
}

fn parse_research_job(value: &Value) -> Option<ResearchJob> {
    let id = value_text(value.get("id"))?;
    let title = value_text(value.get("title")).unwrap_or_else(|| "Autoresearch".to_string());
    let status = value_text(value.get("status")).unwrap_or_else(|| "idle".to_string());
    let optimizing = value_text(value.get("metricName"))
        .or_else(|| value_text(value.get("optimizing")))
        .unwrap_or_else(|| "metric".to_string());
    let metric = value_optional_text(value.get("metricKind"));
    let iterations = value
        .get("iterations")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .enumerate()
                .map(|(index, iteration)| ResearchIteration {
                    id: iteration
                        .get("index")
                        .and_then(Value::as_u64)
                        .map(|value| value.to_string())
                        .unwrap_or_else(|| index.to_string()),
                    at: value_text(iteration.get("at")).unwrap_or_default(),
                    status: value_text(iteration.get("outcome"))
                        .unwrap_or_else(|| "unknown".to_string()),
                    metric: value_optional_number_text(iteration.get("value")),
                    note: value_optional_text(iteration.get("note")),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let best = value_optional_number_text(value.get("best")).or_else(|| {
        iterations
            .iter()
            .rev()
            .find_map(|iteration| iteration.metric.clone())
    });
    let mut metrics = Vec::new();
    for (label, key) in [
        ("Attempts", "iterations"),
        ("Spent seconds", "spentSeconds"),
        ("Spent tokens", "spentTokens"),
        ("Spent micro-USD", "spentMicroDollars"),
    ] {
        let value = if key == "iterations" {
            iterations.len().to_string()
        } else {
            value_text(value.get(key)).unwrap_or_else(|| "0".to_string())
        };
        metrics.push(ResearchMetric {
            label: label.to_string(),
            value,
        });
    }
    Some(ResearchJob {
        id,
        title,
        status: status.clone(),
        since: value_optional_text(value.get("createdAt")),
        optimizing,
        metric,
        best,
        attempts: iterations.len(),
        note: value_optional_text(value.get("statusNote")),
        metrics,
        iterations,
    })
}

fn thread_message_count(value: &Value) -> usize {
    value.get("messages").and_then(Value::as_array).map_or_else(
        || {
            value
                .get("messageCount")
                .and_then(Value::as_u64)
                .unwrap_or_default() as usize
        },
        Vec::len,
    )
}

fn thread_model(thread: &ThreadData) -> Option<String> {
    thread.messages.iter().rev().find_map(|message| {
        let model = message.generation.as_ref()?.model.trim();
        if model.is_empty() {
            None
        } else {
            Some(model.to_string())
        }
    })
}

fn value_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        Value::Number(value) => Some(value.to_string()),
        Value::Bool(value) => Some(value.to_string()),
        _ => None,
    }
}

fn value_optional_text(value: Option<&Value>) -> Option<String> {
    value_text(value)
}

fn value_optional_number_text(value: Option<&Value>) -> Option<String> {
    match value? {
        Value::Number(value) => Some(value.to_string()),
        Value::String(value) if !value.is_empty() => Some(value.clone()),
        _ => None,
    }
}

fn configured_permission_mode() -> String {
    match env::var("EMMA_PERMISSION_MODE").ok().as_deref() {
        Some("plan") => "plan".to_string(),
        Some("ask") => "ask".to_string(),
        Some("acceptEdits") => "acceptEdits".to_string(),
        Some("auto") => "auto".to_string(),
        Some("full") => "full".to_string(),
        _ => "ask".to_string(),
    }
}

fn bridge_request_id(body: &str) -> Option<u64> {
    serde_json::from_str::<Value>(body)
        .ok()?
        .get("n")
        .and_then(Value::as_u64)
}

fn open_external_url(url: &str) -> Result<(), String> {
    if emma_app::browser_surface::normalize_navigation_url(url).is_err() {
        return Err("Only http and https links can be opened externally".to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("open");
    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("cmd");
        command.args(["/C", "start", ""]);
        command
    };
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    let mut command = Command::new("xdg-open");
    command
        .arg(url)
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("Could not open the link externally: {error}"))
}

fn configured_model() -> Option<String> {
    let value = env::var("EMMA_MODEL").ok()?;
    let value = value.trim();
    if value.is_empty() || value.len() > 128 || !value.is_ascii() {
        return None;
    }
    Some(value.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completion_replaces_only_the_active_token() {
        assert_eq!(replace_active_completion("Use /pla", "plan"), "Use /plan ");
        assert_eq!(replace_active_completion("Ask @em", "emma"), "Ask @emma ");
        assert_eq!(
            replace_active_completion("plain text", "command"),
            "plain command "
        );
        let menu = completion_menu_for("Use /a", false, 0).expect("slash menu");
        assert_eq!(menu.items[0].id, "agent");
        assert_eq!(
            move_completion(0, menu.items.len(), -1),
            menu.items.len() - 1
        );
        assert!(completion_menu_for("a/b", false, 0).is_none());
    }

    #[test]
    fn pane_resize_uses_renderer_bounds() {
        let mut layout = PaneLayout::default();
        resize_pane_layout(&mut layout, ShellPane::Sidebar, -1_000);
        assert_eq!(layout.sidebar_width, 200.);
        resize_pane_layout(&mut layout, ShellPane::Sidebar, 1_000);
        assert_eq!(layout.sidebar_width, 340.);
        resize_pane_layout(&mut layout, ShellPane::Inspector, 1_000);
        assert_eq!(layout.inspector_width, 260.);
        resize_pane_layout(&mut layout, ShellPane::Inspector, -1_000);
        assert_eq!(layout.inspector_width, 360.);
        let viewport = gpui::size(px(1_200.), px(800.));
        resize_pane_to(&mut layout, ShellPane::Sidebar, 250, viewport);
        assert_eq!(layout.sidebar_width, 250.);
        resize_pane_to(&mut layout, ShellPane::Inspector, 900, viewport);
        assert_eq!(layout.inspector_width, 300.);
        resize_pane_to(&mut layout, ShellPane::Terminal, 550, viewport);
        assert_eq!(layout.terminal_height, 250.);
        resize_pane_layout(&mut layout, ShellPane::Browser, -1_000);
        assert_eq!(layout.browser_width, 260.);
        resize_pane_layout(&mut layout, ShellPane::Browser, 1_000);
        assert_eq!(layout.browser_width, 720.);
    }

    #[test]
    fn browser_bridge_request_ids_are_bounded_numbers() {
        assert_eq!(bridge_request_id(r#"{"n":12}"#), Some(12));
        assert_eq!(bridge_request_id(r#"{"n":"12"}"#), None);
        assert_eq!(bridge_request_id(r#"{"n":-1}"#), None);
        assert_eq!(bridge_request_id("null"), None);
    }

    #[test]
    fn scheduled_steps_preserve_snapshot_nodes() {
        let steps = scheduled_steps(
            r#"[{"id":"first","kind":"agent","prompt":"Read","next":"second"},{"id":"second","kind":"save","text":"Write"}]"#,
            "fallback",
        );
        assert_eq!(steps.len(), 2);
        assert_eq!(steps[0].id, "first");
        assert_eq!(steps[0].text, "Read");
        assert_eq!(steps[0].details.as_deref(), Some("next second"));
        assert_eq!(steps[1].kind, "save");
    }

    #[test]
    fn empty_schedule_uses_prompt_surface() {
        let steps = scheduled_steps("[]", "Do the thing");
        assert_eq!(steps.len(), 1);
        assert_eq!(steps[0].id, "prompt");
        assert!(valid_scheduled_draft(&ScheduledDraft {
            id: None,
            title: "Task".to_string(),
            model: "model".to_string(),
            trigger: "manual".to_string(),
            prompt: "Do the thing".to_string(),
            runs_as: "ask".to_string(),
            enabled: true,
        }));
    }

    #[test]
    fn conversation_and_settings_ids_translate_stably() {
        assert_eq!(conversation_role("user"), ConversationRole::User);
        assert_eq!(conversation_role("system"), ConversationRole::System);
        assert_eq!(conversation_role("unknown"), ConversationRole::Assistant);
        assert_eq!(SettingsPageId::ALL.len(), 15);
        assert_eq!(
            conversation_permission_id(PermissionMode::AcceptEdits),
            "acceptEdits"
        );
        assert_eq!(
            settings_permission_id(settings_pages::PermissionMode::Plan),
            "plan"
        );
        assert_eq!(host_permission_mode("auto"), "ask");
        assert_eq!(host_permission_mode("acceptEdits"), "acceptEdits");
    }

    #[test]
    fn research_create_omits_id_but_edit_keeps_selection() {
        let mut page = ResearchPage::default();
        assert!(selected_research_job_id(&page).is_null());
        page.selected = Some("research-1".to_string());
        assert_eq!(
            selected_research_job_id(&page),
            Value::String("research-1".to_string())
        );
    }
}
