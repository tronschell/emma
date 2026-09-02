use std::{collections::BTreeMap, mem};

use gpui::{AnyWindowHandle, SharedString};

use crate::{
    conversation::PermissionMode,
    native_windows::{
        AnnotationWindowPhase, ComputerRunRequest, HotspotPollRequest, NativeDisplay,
        NativeHostPlatform, NativeWindowCommand, NativeWindowController, NativeWindowRole,
    },
    navigation::OverlaySurface,
    overlay_surfaces::{
        ANNOTATION_SETTLE_MS, AnnotationAttachment, AnnotationPoint, AnnotationState,
        AnnotationStroke, COMPUTER_CURSOR_LIFETIME_MS, ComputerProgress, GeometryPoint,
        NOTCH_WAVE_BUSY_MS, NOTCH_WAVE_IDLE_MS, NotchGeometry, NotchPlacement, OrbCommand,
        OverlayAction, OverlayModel, OverlayState, OverlayStream, OverlayTurn, PILL_FADE_MS,
        PILL_LINGER_MS, PillStatus, SlashItem, SurfaceRect, overlay_growth, overlay_layout,
        pill_layout,
    },
};

pub const MIGRATE_AFTER: usize = 6;
pub const MAX_OVERLAY_MESSAGE_CHARS: usize = 65_536;
pub const MAX_OVERLAY_TURNS: usize = 64;
pub const MAX_OVERLAY_STEPS: usize = 128;
pub const MAX_OVERLAY_CHOICES: usize = 16;
pub const MAX_SLASH_MATCHES: usize = 20;
pub const MAX_SOURCE_ITEMS: usize = 64;
pub const MAX_ORB_COMMANDS: usize = 16;
pub const MAX_ANNOTATION_STROKES: usize = 512;
pub const MAX_ANNOTATION_POINTS: usize = 4_096;
pub const MAX_ANNOTATION_COORDINATE: f32 = 16_384.;
pub const PILL_DRAG_THRESHOLD: f32 = 3.;
pub const NOTCH_GAP_MIN: f32 = 120.;
pub const NOTCH_GAP_MAX: f32 = 260.;

#[derive(Clone, Debug, PartialEq)]
pub struct OverlayRuntimeConfig {
    pub platform: NativeHostPlatform,
    pub notch_gap: f32,
    pub cursor_orbs_enabled: bool,
    pub notch_concurrency: crate::native_windows::QuickAskConcurrency,
    pub reduced_motion: bool,
}

impl Default for OverlayRuntimeConfig {
    fn default() -> Self {
        Self {
            platform: NativeHostPlatform::Other,
            notch_gap: 180.,
            cursor_orbs_enabled: false,
            notch_concurrency: crate::native_windows::QuickAskConcurrency::Continue,
            reduced_motion: false,
        }
    }
}

impl OverlayRuntimeConfig {
    pub fn set_notch_gap(&mut self, value: f32) {
        self.notch_gap = bounded_notch_gap(value);
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OverlayFocus {
    None,
    Workspace,
    QuickAsk,
    ScreenAnnotation,
    NotchHotspot,
    RadialCommands,
    ComputerRunBanner,
    ComputerActivityCursor,
}

impl OverlayFocus {
    pub const fn role(self) -> Option<NativeWindowRole> {
        match self {
            Self::None | Self::Workspace => None,
            Self::QuickAsk => Some(NativeWindowRole::QuickAsk),
            Self::ScreenAnnotation => Some(NativeWindowRole::ScreenAnnotation),
            Self::NotchHotspot => Some(NativeWindowRole::NotchHotspot),
            Self::RadialCommands => Some(NativeWindowRole::RadialCommands),
            Self::ComputerRunBanner => Some(NativeWindowRole::ComputerRunBanner),
            Self::ComputerActivityCursor => Some(NativeWindowRole::ComputerActivityCursor),
        }
    }

    pub const fn from_role(role: NativeWindowRole) -> Self {
        match role {
            NativeWindowRole::Workspace => Self::Workspace,
            NativeWindowRole::QuickAsk => Self::QuickAsk,
            NativeWindowRole::ScreenAnnotation => Self::ScreenAnnotation,
            NativeWindowRole::NotchHotspot => Self::NotchHotspot,
            NativeWindowRole::RadialCommands => Self::RadialCommands,
            NativeWindowRole::ComputerRunBanner => Self::ComputerRunBanner,
            NativeWindowRole::ComputerActivityCursor => Self::ComputerActivityCursor,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum OverlayTimer {
    NotchWave,
    HotspotPoll,
    PillLinger,
    PillFade,
    AnnotationSettle,
    ComputerCursor,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OverlayTimerState {
    pub timer: OverlayTimer,
    pub at_ms: u64,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayRuntimeIssue {
    NoDisplay,
    InvalidMessage,
    InvalidPoint,
    InvalidComputerProgress,
    MissingAnnotation,
    Busy,
    MigrationNotReady,
    UnsupportedAction,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayAcpEffect {
    Submit {
        text: SharedString,
        model: OverlayModel,
        mode: PermissionMode,
        annotation: Option<AnnotationAttachment>,
    },
    Cancel,
    SelectModel(SharedString),
    SelectMode(PermissionMode),
    RunCommand(SharedString),
    Choice(SharedString),
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayServiceEffect {
    StartDictation,
    StopDictation,
    CaptureScreen,
    SaveScreen,
    ClearAnnotation(SharedString),
    CaptureAnnotationFrame { strokes: Vec<AnnotationStroke> },
    SelectSource(SharedString),
    StopComputerRun(SharedString),
    RequestFrontContext,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayEffect {
    Native(NativeWindowCommand),
    Acp(OverlayAcpEffect),
    Service(OverlayServiceEffect),
    ScheduleTimer { timer: OverlayTimer, at_ms: u64 },
    CancelTimer(OverlayTimer),
    RestoreFocus,
    Unavailable(OverlayRuntimeIssue),
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct OverlayOutput {
    pub effects: Vec<OverlayEffect>,
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayInput {
    Action {
        action: OverlayAction,
        now_ms: u64,
    },
    Tick {
        now_ms: u64,
    },
    DisplayChanged {
        display: NativeDisplay,
        notch: Option<NotchGeometry>,
        now_ms: u64,
    },
    CursorMoved {
        display: NativeDisplay,
        point: GeometryPoint,
        now_ms: u64,
    },
    HotspotPoll {
        display: NativeDisplay,
        notch: Option<NotchGeometry>,
        cursor: GeometryPoint,
        now_ms: u64,
    },
    HotspotHover(bool),
    OpenRadial {
        display: NativeDisplay,
        cursor: GeometryPoint,
        now_ms: u64,
    },
    SetReducedMotion(bool),
    SetNotchGap(f32),
    SetGrowth(f32),
    SetBusy {
        busy: bool,
        now_ms: u64,
    },
    SetError {
        message: Option<SharedString>,
        now_ms: u64,
    },
    SetStream(OverlayStream),
    AppendTurn(OverlayTurn),
    SetTurns(Vec<OverlayTurn>),
    SetDictation {
        listening: bool,
        transcribing: bool,
        error: Option<SharedString>,
    },
    SetDictationReady(bool),
    DictationText(SharedString),
    SetSlashContext {
        query: Option<SharedString>,
        matches: Vec<SlashItem>,
        active: usize,
        start: usize,
        end: usize,
        sigil: char,
    },
    SetSourceItems(Vec<SlashItem>),
    SetCommands(Vec<OrbCommand>),
    SetModelOptions(Vec<OverlayModel>),
    SetContext {
        tokens: Option<u32>,
        rate: Option<u32>,
    },
    SetAnnotation(Option<AnnotationAttachment>),
    AnnotationCaptured(AnnotationAttachment),
    AnnotationError(SharedString),
    StartComputer {
        display: NativeDisplay,
        request: ComputerRunRequest,
        now_ms: u64,
    },
    ComputerReady,
    ComputerProgress {
        progress: ComputerProgress,
        now_ms: u64,
    },
    ComputerFinished {
        thread_id: SharedString,
        error: Option<SharedString>,
        now_ms: u64,
    },
    WindowLoaded(NativeWindowRole),
    WindowClosed(NativeWindowRole),
    WindowOpenFailed(NativeWindowRole),
    WindowBlur {
        role: NativeWindowRole,
        now_ms: u64,
    },
    Escape {
        role: Option<NativeWindowRole>,
        now_ms: u64,
    },
}

#[derive(Clone, Copy, Debug, PartialEq)]
struct PillDrag {
    origin: GeometryPoint,
    moved: bool,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnnotationRuntimeState {
    pub state: AnnotationState,
    pub display_id: Option<u64>,
    pub bounds: Option<SurfaceRect>,
    pub capture_pending: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComputerRuntimeState {
    pub request: ComputerRunRequest,
    pub display_id: u64,
    pub progress: ComputerProgress,
    pub active: bool,
    pub cursor_ready: bool,
    pub cursor_visible_until_ms: Option<u64>,
}

pub struct OverlayRuntime {
    pub state: OverlayState,
    pub annotation: AnnotationRuntimeState,
    pub computer: Option<ComputerRuntimeState>,
    pub focus: OverlayFocus,
    pub display: Option<NativeDisplay>,
    pub notch_geometry: Option<NotchGeometry>,
    pub cursor: Option<GeometryPoint>,
    pub native: NativeWindowController,
    config: OverlayRuntimeConfig,
    timers: BTreeMap<OverlayTimer, u64>,
    now_ms: u64,
    pill_spot: Option<GeometryPoint>,
    pill_drag: Option<PillDrag>,
    pub hotspot_hovering: bool,
    pending_message: Option<SharedString>,
    dictation_ready: bool,
    slash_range: Option<(usize, usize, char)>,
    notch_wave_frame: u64,
}

impl Default for OverlayRuntime {
    fn default() -> Self {
        Self::new(OverlayRuntimeConfig::default())
    }
}

impl OverlayRuntime {
    pub fn new(mut config: OverlayRuntimeConfig) -> Self {
        config.set_notch_gap(config.notch_gap);
        let mut native = NativeWindowController::new(config.platform);
        native.set_reduced_motion(config.reduced_motion);
        let state = OverlayState {
            surface: if config.platform.is_windows() {
                OverlaySurface::Pill
            } else {
                OverlaySurface::Notch
            },
            reduced_motion: config.reduced_motion,
            notch: NotchPlacement {
                left: 0.,
                width: config.notch_gap,
                height: 32.,
            },
            ..OverlayState::default()
        };
        Self {
            state,
            annotation: AnnotationRuntimeState {
                state: AnnotationState {
                    reduced_motion: config.reduced_motion,
                    ..AnnotationState::default()
                },
                ..AnnotationRuntimeState::default()
            },
            computer: None,
            focus: OverlayFocus::None,
            display: None,
            notch_geometry: None,
            cursor: None,
            native,
            config,
            timers: BTreeMap::new(),
            now_ms: 0,
            pill_spot: None,
            pill_drag: None,
            hotspot_hovering: false,
            pending_message: None,
            dictation_ready: false,
            slash_range: None,
            notch_wave_frame: 0,
        }
    }

    pub fn config(&self) -> &OverlayRuntimeConfig {
        &self.config
    }

    pub fn focus(&self) -> OverlayFocus {
        self.focus
    }

    pub fn now_ms(&self) -> u64 {
        self.now_ms
    }

    pub fn notch_wave_frame(&self) -> u64 {
        self.notch_wave_frame
    }

    pub fn pill_spot(&self) -> Option<GeometryPoint> {
        self.pill_spot
    }

    pub fn timer(&self, timer: OverlayTimer) -> Option<OverlayTimerState> {
        self.timers
            .get(&timer)
            .copied()
            .map(|at_ms| OverlayTimerState { timer, at_ms })
    }

    pub fn timers(&self) -> Vec<OverlayTimerState> {
        self.timers
            .iter()
            .map(|(&timer, &at_ms)| OverlayTimerState { timer, at_ms })
            .collect()
    }

    pub fn native_controller(&self) -> &NativeWindowController {
        &self.native
    }

    pub fn native_controller_mut(&mut self) -> &mut NativeWindowController {
        &mut self.native
    }

    pub fn attach_opened(
        &mut self,
        spec: crate::native_windows::NativeWindowSpec,
        handle: AnyWindowHandle,
    ) -> bool {
        self.native.attach_opened(spec, handle)
    }

    pub fn dispatch_action(&mut self, action: OverlayAction, now_ms: u64) -> OverlayOutput {
        self.dispatch(OverlayInput::Action { action, now_ms })
    }

    pub fn tick(&mut self, now_ms: u64) -> OverlayOutput {
        self.dispatch(OverlayInput::Tick { now_ms })
    }

    pub fn set_display(
        &mut self,
        display: NativeDisplay,
        notch: Option<NotchGeometry>,
        now_ms: u64,
    ) -> OverlayOutput {
        self.dispatch(OverlayInput::DisplayChanged {
            display,
            notch,
            now_ms,
        })
    }

    pub fn set_reduced_motion(&mut self, reduced_motion: bool) -> OverlayOutput {
        self.dispatch(OverlayInput::SetReducedMotion(reduced_motion))
    }

    pub fn dispatch(&mut self, input: OverlayInput) -> OverlayOutput {
        let mut output = OverlayOutput::default();
        match input {
            OverlayInput::Action { action, now_ms } => {
                self.advance_to(now_ms, &mut output.effects);
                self.reduce_action(action, &mut output.effects);
            }
            OverlayInput::Tick { now_ms } => self.advance_to(now_ms, &mut output.effects),
            OverlayInput::DisplayChanged {
                display,
                notch,
                now_ms,
            } => {
                self.advance_to(now_ms, &mut output.effects);
                self.set_display_state(display, notch, &mut output.effects);
            }
            OverlayInput::CursorMoved {
                display,
                point,
                now_ms,
            } => {
                self.advance_to(now_ms, &mut output.effects);
                if let Some(point) = valid_geometry_point(point) {
                    self.display = Some(display);
                    self.cursor = Some(point);
                    if self.notch_geometry.is_some() {
                        self.poll_hotspot(display, self.notch_geometry, point, &mut output.effects);
                    }
                } else {
                    output.effects.push(OverlayEffect::Unavailable(
                        OverlayRuntimeIssue::InvalidPoint,
                    ));
                }
            }
            OverlayInput::HotspotPoll {
                display,
                notch,
                cursor,
                now_ms,
            } => {
                self.advance_to(now_ms, &mut output.effects);
                if let Some(cursor) = valid_geometry_point(cursor) {
                    self.set_display_state(display, notch, &mut output.effects);
                    self.cursor = Some(cursor);
                    self.poll_hotspot(display, notch, cursor, &mut output.effects);
                } else {
                    output.effects.push(OverlayEffect::Unavailable(
                        OverlayRuntimeIssue::InvalidPoint,
                    ));
                }
            }
            OverlayInput::HotspotHover(hovering) => {
                self.hotspot_hovering = hovering;
                self.schedule_timer(
                    OverlayTimer::HotspotPoll,
                    crate::overlay_surfaces::hotspot_poll_delay(hovering),
                    &mut output.effects,
                );
            }
            OverlayInput::OpenRadial {
                display,
                cursor,
                now_ms,
            } => {
                self.advance_to(now_ms, &mut output.effects);
                if let Some(cursor) = valid_geometry_point(cursor) {
                    self.display = Some(display);
                    self.cursor = Some(cursor);
                    self.open_radial(display, cursor, &mut output.effects);
                } else {
                    output.effects.push(OverlayEffect::Unavailable(
                        OverlayRuntimeIssue::InvalidPoint,
                    ));
                }
            }
            OverlayInput::SetReducedMotion(reduced_motion) => {
                self.set_motion(reduced_motion, &mut output.effects);
            }
            OverlayInput::SetNotchGap(value) => {
                self.config.set_notch_gap(value);
                if let Some(display) = self.display {
                    self.set_display_state(display, self.notch_geometry, &mut output.effects);
                }
            }
            OverlayInput::SetGrowth(value) => {
                self.state.grow = overlay_growth(value);
                Self::emit_native(
                    self.native.set_overlay_growth(self.state.grow),
                    &mut output.effects,
                );
            }
            OverlayInput::SetBusy { busy, now_ms } => {
                self.advance_to(now_ms, &mut output.effects);
                self.set_busy(busy, &mut output.effects);
            }
            OverlayInput::SetError { message, now_ms } => {
                self.advance_to(now_ms, &mut output.effects);
                self.set_error(message, &mut output.effects);
            }
            OverlayInput::SetStream(stream) => self.set_stream(stream),
            OverlayInput::AppendTurn(turn) => self.append_turn(turn),
            OverlayInput::SetTurns(turns) => self.set_turns(turns),
            OverlayInput::SetDictation {
                listening,
                transcribing,
                error,
            } => {
                self.state.listening = listening;
                self.state.transcribing = transcribing;
                self.state.dictation_error = error.map(|value| bounded_shared(&value, 512));
            }
            OverlayInput::SetDictationReady(ready) => self.dictation_ready = ready,
            OverlayInput::DictationText(text) => self.append_dictation(text),
            OverlayInput::SetSlashContext {
                query,
                matches,
                active,
                start,
                end,
                sigil,
            } => self.set_slash_context(query, matches, active, start, end, sigil),
            OverlayInput::SetSourceItems(items) => {
                self.state.source_items = bounded_items(items, MAX_SOURCE_ITEMS)
            }
            OverlayInput::SetCommands(commands) => {
                self.state.commands = commands.into_iter().take(MAX_ORB_COMMANDS).collect()
            }
            OverlayInput::SetModelOptions(options) => {
                self.state.model_options = options.into_iter().take(MAX_SOURCE_ITEMS).collect()
            }
            OverlayInput::SetContext { tokens, rate } => {
                self.state.context_tokens = tokens;
                self.state.rate = rate;
            }
            OverlayInput::SetAnnotation(attachment) => {
                self.state.annotation = attachment;
                if self.native.capturing() {
                    self.finish_screen_capture(&mut output.effects);
                }
            }
            OverlayInput::AnnotationCaptured(attachment) => {
                self.state.annotation = Some(attachment);
                self.annotation.capture_pending = false;
                self.set_native_annotation_phase(AnnotationWindowPhase::Ready);
                Self::emit_native(self.native.finish_annotation(), &mut output.effects);
                self.annotation = AnnotationRuntimeState::default();
                self.annotation.state.reduced_motion = self.config.reduced_motion;
                self.focus = OverlayFocus::QuickAsk;
            }
            OverlayInput::AnnotationError(error) => {
                self.annotation.state.error = Some(bounded_shared(&error, 512));
                self.annotation.capture_pending = false;
                self.set_native_annotation_phase(AnnotationWindowPhase::Failed);
            }
            OverlayInput::StartComputer {
                display,
                request,
                now_ms,
            } => {
                self.advance_to(now_ms, &mut output.effects);
                self.start_computer(display, request, &mut output.effects);
            }
            OverlayInput::ComputerReady => self.computer_ready(&mut output.effects),
            OverlayInput::ComputerProgress { progress, now_ms } => {
                self.advance_to(now_ms, &mut output.effects);
                self.update_computer(progress, &mut output.effects);
            }
            OverlayInput::ComputerFinished {
                thread_id,
                error,
                now_ms,
            } => {
                self.advance_to(now_ms, &mut output.effects);
                self.finish_computer(thread_id, error, &mut output.effects);
            }
            OverlayInput::WindowLoaded(role) => {
                Self::emit_native(self.native.reveal_after_load(role), &mut output.effects);
                if matches!(
                    role,
                    NativeWindowRole::Workspace
                        | NativeWindowRole::QuickAsk
                        | NativeWindowRole::ScreenAnnotation
                ) {
                    self.focus = OverlayFocus::from_role(role);
                }
            }
            OverlayInput::WindowClosed(role) => self.window_closed(role, &mut output.effects),
            OverlayInput::WindowOpenFailed(role) => {
                self.native.mark_open_failed(role);
                self.state.error = Some(format!("Emma could not open {}", role.id()).into());
                self.focus = OverlayFocus::Workspace;
                output.effects.push(OverlayEffect::Unavailable(
                    OverlayRuntimeIssue::UnsupportedAction,
                ));
            }
            OverlayInput::WindowBlur { role, now_ms } => {
                self.advance_to(now_ms, &mut output.effects);
                self.window_blurred(role, &mut output.effects);
            }
            OverlayInput::Escape { role, now_ms } => {
                self.advance_to(now_ms, &mut output.effects);
                self.escape(role, &mut output.effects);
            }
        }
        output
    }

    fn reduce_action(&mut self, action: OverlayAction, effects: &mut Vec<OverlayEffect>) {
        match action {
            OverlayAction::SetMessage(message) => self.set_message(message),
            OverlayAction::Submit(message) => self.submit(message, effects),
            OverlayAction::DismissOverlay => self.dismiss_overlay(effects),
            OverlayAction::StartDrawing => self.start_annotation(effects),
            OverlayAction::ToggleDictation => self.toggle_dictation(effects),
            OverlayAction::CaptureScreen => self.capture_screen(effects),
            OverlayAction::SaveScreen => self.save_screen(effects),
            OverlayAction::ClearAnnotation(id) => self.clear_annotation(id, effects),
            OverlayAction::OpenOverlay => self.open_overlay(None, effects),
            OverlayAction::OpenWorkspace(page) => self.open_workspace(page, effects),
            OverlayAction::MigrateToWorkspace => {
                if self.state.turns.len() >= MIGRATE_AFTER {
                    self.open_workspace(None, effects);
                } else {
                    effects.push(OverlayEffect::Unavailable(
                        OverlayRuntimeIssue::MigrationNotReady,
                    ));
                }
            }
            OverlayAction::ToggleModels => self.toggle_models(),
            OverlayAction::PickModel(key) => self.pick_model(key, effects),
            OverlayAction::ToggleModes => self.toggle_modes(),
            OverlayAction::PickMode(mode) => self.pick_mode(mode, effects),
            OverlayAction::NavigateSlash(delta) => self.navigate_slash(delta),
            OverlayAction::PickSlash(name) => self.pick_slash(name),
            OverlayAction::PickSource(source) => self.pick_source(source, effects),
            OverlayAction::DismissSlash => self.dismiss_slash(),
            OverlayAction::RunCommand(command) => self.run_command(command, effects),
            OverlayAction::Choice(choice) => {
                if !self.state.busy {
                    effects.push(OverlayEffect::Acp(OverlayAcpEffect::Choice(
                        bounded_shared(&choice, 128),
                    )));
                }
            }
            OverlayAction::BeginPillDrag(point) => self.begin_pill_drag(point, effects),
            OverlayAction::MovePill(point) => self.move_pill(point, effects),
            OverlayAction::EndPillDrag => self.end_pill_drag(effects),
            OverlayAction::ExpandPill => self.expand_pill(effects),
            OverlayAction::DismissPill => self.dismiss_pill(effects),
            OverlayAction::SelectOrb(command) => self.select_orb(command, effects),
            OverlayAction::AnnotationBegin(point) => self.annotation_begin(point, effects),
            OverlayAction::AnnotationDraw(point) => self.annotation_draw(point, effects),
            OverlayAction::AnnotationEnd => self.annotation_end(effects),
            OverlayAction::FinishAnnotation => self.finish_annotation(effects),
            OverlayAction::CancelAnnotation => self.cancel_annotation(effects),
            OverlayAction::StopComputerRun => self.stop_computer(effects),
        }
    }

    fn set_display_state(
        &mut self,
        display: NativeDisplay,
        notch: Option<NotchGeometry>,
        effects: &mut Vec<OverlayEffect>,
    ) {
        self.display = Some(display);
        self.notch_geometry = notch;
        self.state.notch = self.notch_placement();
        if self.native.is_present(NativeWindowRole::QuickAsk) {
            let bounds = self.overlay_bounds(display);
            Self::emit_native(
                vec![
                    NativeWindowCommand::SetBounds {
                        role: NativeWindowRole::QuickAsk,
                        bounds,
                    },
                    NativeWindowCommand::UpdateQuickAskSurface {
                        surface: self.state.surface,
                        notch: self.state.notch,
                    },
                ],
                effects,
            );
        }
        if self.native.is_present(NativeWindowRole::NotchHotspot) {
            let cursor = self.cursor.unwrap_or(GeometryPoint {
                x: display.geometry.bounds.x + display.geometry.bounds.width * 0.5,
                y: display.geometry.bounds.y,
            });
            self.poll_hotspot(display, notch, cursor, effects);
        }
        if self.native.is_present(NativeWindowRole::ComputerRunBanner)
            && let Some(computer) = self.computer.as_ref()
        {
            let request = computer.request.clone();
            let spec = crate::native_windows::NativeWindowSpec::computer_run_banner(
                display,
                self.config.platform,
                &request,
                self.config.reduced_motion,
            );
            Self::emit_native(
                vec![NativeWindowCommand::SetBounds {
                    role: NativeWindowRole::ComputerRunBanner,
                    bounds: spec.bounds,
                }],
                effects,
            );
        }
    }

    fn set_motion(&mut self, reduced_motion: bool, effects: &mut Vec<OverlayEffect>) {
        self.config.reduced_motion = reduced_motion;
        self.state.reduced_motion = reduced_motion;
        self.annotation.state.reduced_motion = reduced_motion;
        self.native.set_reduced_motion(reduced_motion);
        if reduced_motion {
            self.notch_wave_frame = 0;
            self.cancel_timer(OverlayTimer::NotchWave, effects);
        } else if self.native.is_present(NativeWindowRole::QuickAsk)
            && self.state.surface == OverlaySurface::Notch
        {
            self.schedule_wave(effects);
        }
    }

    fn set_busy(&mut self, busy: bool, effects: &mut Vec<OverlayEffect>) {
        let was_busy = self.state.busy;
        self.state.busy = busy;
        self.state.error = if busy { None } else { self.state.error.clone() };
        self.state.pill_leaving = false;
        self.state.pill_status = if busy {
            PillStatus::Working
        } else if self.state.error.is_some() {
            PillStatus::Error
        } else {
            PillStatus::Done
        };
        self.state.pill_label = if busy {
            self.working_label()
        } else if let Some(error) = self.state.error.clone() {
            error
        } else {
            SharedString::new_static("Done")
        };
        if busy {
            self.cancel_timer(OverlayTimer::PillLinger, effects);
            self.cancel_timer(OverlayTimer::PillFade, effects);
        } else if was_busy
            && self.state.surface == OverlaySurface::Pill
            && self.state.error.is_none()
        {
            self.schedule_timer(OverlayTimer::PillLinger, PILL_LINGER_MS, effects);
        }
        Self::emit_native(self.native.set_overlay_busy(busy), effects);
        if self.state.surface == OverlaySurface::Notch
            && self.native.is_present(NativeWindowRole::QuickAsk)
        {
            if self.config.reduced_motion {
                self.cancel_timer(OverlayTimer::NotchWave, effects);
            } else {
                self.schedule_wave(effects);
            }
        }
    }

    fn set_error(&mut self, message: Option<SharedString>, effects: &mut Vec<OverlayEffect>) {
        self.state.error = message.map(|value| bounded_shared(&value, 2_048));
        if self.state.error.is_some() {
            self.state.busy = false;
            if let Some(pending) = self.pending_message.clone() {
                self.state.message = pending;
            }
            self.state.pill_status = PillStatus::Error;
            self.state.pill_label = self.state.error.clone().unwrap_or_default();
            Self::emit_native(self.native.set_overlay_busy(false), effects);
        } else {
            self.state.pill_status = PillStatus::Done;
            self.state.pill_label = SharedString::new_static("Done");
        }
    }

    fn set_stream(&mut self, mut stream: OverlayStream) {
        stream.text = bounded_shared(&stream.text, MAX_OVERLAY_MESSAGE_CHARS);
        stream.steps.truncate(MAX_OVERLAY_STEPS);
        for step in &mut stream.steps {
            step.id = bounded_shared(&step.id, 128);
            step.title = bounded_shared(&step.title, 256);
            step.kind = bounded_shared(&step.kind, 64);
            step.status = bounded_shared(&step.status, 64);
        }
        self.state.stream = stream;
        if self.state.busy {
            self.state.pill_label = self.working_label();
        }
    }

    fn append_turn(&mut self, mut turn: OverlayTurn) {
        turn.content = bounded_shared(&turn.content, MAX_OVERLAY_MESSAGE_CHARS);
        turn.steps.truncate(MAX_OVERLAY_STEPS);
        turn.choices.truncate(MAX_OVERLAY_CHOICES);
        if self.state.turns.len() == MAX_OVERLAY_TURNS {
            self.state.turns.remove(0);
        }
        self.state.turns.push(turn);
        if self
            .state
            .turns
            .last()
            .is_some_and(|turn| turn.role == crate::overlay_surfaces::OverlayRole::Assistant)
        {
            self.pending_message = None;
        }
    }

    fn set_turns(&mut self, turns: Vec<OverlayTurn>) {
        self.state.turns.clear();
        for turn in turns.into_iter().take(MAX_OVERLAY_TURNS) {
            self.append_turn(turn);
        }
    }

    fn set_message(&mut self, message: SharedString) {
        self.state.message = bounded_shared(&message, MAX_OVERLAY_MESSAGE_CHARS);
    }

    fn submit(&mut self, message: SharedString, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::Busy));
            return;
        }
        let text: SharedString = message
            .trim()
            .chars()
            .take(MAX_OVERLAY_MESSAGE_CHARS)
            .collect::<String>()
            .into();
        if text.is_empty() {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::InvalidMessage,
            ));
            return;
        }
        self.pending_message = Some(text.clone());
        self.state.message = SharedString::new_static("");
        self.state.busy = true;
        self.state.error = None;
        self.state.dictation_error = None;
        self.state.stream = OverlayStream::default();
        self.state.pill_status = PillStatus::Working;
        self.state.pill_label = SharedString::new_static("Working");
        self.state.models_open = false;
        self.state.modes_open = false;
        self.state.slash_open = false;
        self.state.source_menu_open = false;
        self.state.commands_open = false;
        self.append_turn(OverlayTurn::user(text.clone()));
        effects.push(OverlayEffect::Acp(OverlayAcpEffect::Submit {
            text,
            model: self.state.model.clone(),
            mode: self.state.mode,
            annotation: self.state.annotation.clone(),
        }));
    }

    fn dismiss_overlay(&mut self, effects: &mut Vec<OverlayEffect>) {
        let had_menu = self.state.models_open
            || self.state.modes_open
            || self.state.slash_open
            || self.state.source_menu_open
            || self.state.commands_open;
        self.state.models_open = false;
        self.state.modes_open = false;
        self.state.slash_open = false;
        self.state.source_menu_open = false;
        self.state.commands_open = false;
        if had_menu {
            self.focus = OverlayFocus::QuickAsk;
            return;
        }
        Self::emit_native(self.native.close_overlay(), effects);
        self.focus = OverlayFocus::Workspace;
        effects.push(OverlayEffect::RestoreFocus);
    }

    fn start_annotation(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::Busy));
            return;
        }
        let Some(display) = self.display else {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::NoDisplay));
            return;
        };
        let commands = self.native.start_annotation(display);
        if commands.is_empty() {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::UnsupportedAction,
            ));
            return;
        }
        self.annotation = AnnotationRuntimeState {
            state: AnnotationState {
                reduced_motion: self.config.reduced_motion,
                ..AnnotationState::default()
            },
            display_id: Some(display.id),
            bounds: Some(display.geometry.bounds),
            capture_pending: false,
        };
        Self::emit_native(commands, effects);
        self.focus = OverlayFocus::ScreenAnnotation;
        self.state.models_open = false;
        self.state.modes_open = false;
        self.state.slash_open = false;
    }

    fn toggle_dictation(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy || self.state.transcribing {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::Busy));
            return;
        }
        if self.state.listening {
            self.state.listening = false;
            effects.push(OverlayEffect::Service(OverlayServiceEffect::StopDictation));
        } else if self.dictation_ready {
            self.state.listening = true;
            self.state.dictation_error = None;
            effects.push(OverlayEffect::Service(OverlayServiceEffect::StartDictation));
        } else {
            self.open_workspace(Some(SharedString::new_static("voice")), effects);
        }
    }

    fn capture_screen(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::Busy));
            return;
        }
        self.native.set_capturing(true);
        Self::emit_native(
            self.native.handle_escape(NativeWindowRole::RadialCommands),
            effects,
        );
        if self.native.is_present(NativeWindowRole::QuickAsk) {
            effects.push(OverlayEffect::Native(NativeWindowCommand::Hide {
                role: NativeWindowRole::QuickAsk,
            }));
        }
        effects.push(OverlayEffect::Service(OverlayServiceEffect::CaptureScreen));
    }

    fn finish_screen_capture(&mut self, effects: &mut Vec<OverlayEffect>) {
        self.native.set_capturing(false);
        Self::emit_native(
            self.native.reveal_after_load(NativeWindowRole::QuickAsk),
            effects,
        );
        if self.native.is_present(NativeWindowRole::QuickAsk) {
            effects.push(OverlayEffect::Native(
                NativeWindowCommand::SendScreenContext,
            ));
        }
        self.focus = OverlayFocus::QuickAsk;
    }

    fn save_screen(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::Busy));
            return;
        }
        self.pending_message = Some(SharedString::new_static("Save what I'm looking at"));
        self.append_turn(OverlayTurn::user("Save what I'm looking at"));
        self.set_busy(true, effects);
        effects.push(OverlayEffect::Service(OverlayServiceEffect::SaveScreen));
    }

    fn clear_annotation(&mut self, id: SharedString, effects: &mut Vec<OverlayEffect>) {
        let id = bounded_shared(&id, 128);
        if self
            .state
            .annotation
            .as_ref()
            .is_some_and(|attachment| attachment.id == id)
        {
            self.state.annotation = None;
            effects.push(OverlayEffect::Service(
                OverlayServiceEffect::ClearAnnotation(id),
            ));
        }
    }

    fn open_overlay(&mut self, command: Option<SharedString>, effects: &mut Vec<OverlayEffect>) {
        let Some(display) = self.display else {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::NoDisplay));
            return;
        };
        let cursor = self.cursor.unwrap_or(GeometryPoint {
            x: display.geometry.bounds.x + display.geometry.bounds.width * 0.5,
            y: display.geometry.bounds.y + display.geometry.bounds.height * 0.5,
        });
        let request = crate::native_windows::QuickAskRequest {
            display,
            notch_gap: self.config.notch_gap,
            notch: self.notch_geometry,
            pill_spot: self.pill_spot,
            cursor,
            cursor_orbs_enabled: self.config.cursor_orbs_enabled && command.is_none(),
            concurrency: self.config.notch_concurrency,
            command,
        };
        Self::emit_native(self.native.toggle_quick_ask(request), effects);
        self.sync_surface();
        self.focus = OverlayFocus::QuickAsk;
        Self::emit_native(self.native.close_hotspot(), effects);
        if self.state.surface == OverlaySurface::Notch && !self.config.reduced_motion {
            self.schedule_wave(effects);
        }
    }

    fn open_workspace(&mut self, page: Option<SharedString>, effects: &mut Vec<OverlayEffect>) {
        let Some(display) = self.display else {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::NoDisplay));
            return;
        };
        let page = page.and_then(|value| bounded_settings_page(&value));
        Self::emit_native(
            self.native.open_workspace_from_overlay(display, page),
            effects,
        );
        self.focus = OverlayFocus::Workspace;
        effects.push(OverlayEffect::RestoreFocus);
    }

    fn toggle_models(&mut self) {
        if self.state.busy {
            return;
        }
        self.state.models_open = !self.state.models_open;
        self.state.modes_open = false;
        self.state.slash_open = false;
        self.state.source_menu_open = false;
        self.state.commands_open = false;
    }

    fn pick_model(&mut self, key: SharedString, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy {
            return;
        }
        let key = bounded_shared(&key, 128);
        if key.is_empty() {
            return;
        }
        if let Some(model) = self
            .state
            .model_options
            .iter()
            .find(|model| model.key == key)
        {
            self.state.model = model.clone();
        } else {
            self.state.model = OverlayModel {
                key: key.clone(),
                label: key.clone(),
                ..OverlayModel::default()
            };
        }
        self.state.models_open = false;
        effects.push(OverlayEffect::Acp(OverlayAcpEffect::SelectModel(key)));
    }

    fn toggle_modes(&mut self) {
        if self.state.busy {
            return;
        }
        self.state.modes_open = !self.state.modes_open;
        self.state.models_open = false;
        self.state.slash_open = false;
        self.state.source_menu_open = false;
        self.state.commands_open = false;
    }

    fn pick_mode(&mut self, mode: PermissionMode, effects: &mut Vec<OverlayEffect>) {
        if self.state.busy {
            return;
        }
        self.state.mode = mode;
        self.state.modes_open = false;
        effects.push(OverlayEffect::Acp(OverlayAcpEffect::SelectMode(mode)));
    }

    fn navigate_slash(&mut self, delta: i32) {
        if !self.state.slash_open || self.state.slash_matches.is_empty() {
            return;
        }
        let len = self.state.slash_matches.len() as i32;
        self.state.slash_active = (self.state.slash_active as i32 + delta).rem_euclid(len) as usize;
    }

    fn pick_slash(&mut self, name: SharedString) {
        let Some((start, end, sigil)) = self.slash_range else {
            return;
        };
        let name = bounded_shared(&name, 256);
        if name.is_empty() || start > end || end > self.state.message.len() {
            return;
        }
        let text = self.state.message.to_string();
        if !text.is_char_boundary(start) || !text.is_char_boundary(end) {
            return;
        }
        let tail = &text[end..];
        let separator = if tail.starts_with(char::is_whitespace) {
            ""
        } else {
            " "
        };
        let replacement = format!("{sigil}{name}{separator}");
        let next = format!("{}{}{}", &text[..start], replacement, tail);
        self.state.message = bounded_shared(&next, MAX_OVERLAY_MESSAGE_CHARS);
        self.state.slash_open = false;
        self.state.slash_query = None;
        self.slash_range = None;
    }

    fn pick_source(&mut self, source: SharedString, effects: &mut Vec<OverlayEffect>) {
        let source = bounded_shared(&source, 256);
        if source.is_empty() {
            return;
        }
        self.state.source_menu_open = false;
        effects.push(OverlayEffect::Service(OverlayServiceEffect::SelectSource(
            source,
        )));
    }

    fn dismiss_slash(&mut self) {
        self.state.slash_open = false;
        self.state.slash_query = None;
        self.slash_range = None;
    }

    fn run_command(&mut self, command: SharedString, effects: &mut Vec<OverlayEffect>) {
        let command = bounded_shared(&command, 128);
        match command.as_ref() {
            "voice" => self.toggle_dictation(effects),
            "page" => self.save_screen(effects),
            "screen" => self.capture_screen(effects),
            "draw" => self.start_annotation(effects),
            "workspace" => self.open_workspace(None, effects),
            _ if !command.is_empty() => {
                effects.push(OverlayEffect::Acp(OverlayAcpEffect::RunCommand(command)))
            }
            _ => {}
        }
    }

    fn begin_pill_drag(&mut self, point: GeometryPoint, effects: &mut Vec<OverlayEffect>) {
        if self.state.surface != OverlaySurface::Pill {
            return;
        }
        let Some(point) = valid_geometry_point(point) else {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::InvalidPoint,
            ));
            return;
        };
        self.pill_drag = Some(PillDrag {
            origin: point,
            moved: false,
        });
    }

    fn move_pill(&mut self, point: GeometryPoint, effects: &mut Vec<OverlayEffect>) {
        let Some(mut drag) = self.pill_drag else {
            return;
        };
        let Some(point) = valid_geometry_point(point) else {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::InvalidPoint,
            ));
            return;
        };
        if !drag.moved
            && (point.x - drag.origin.x).abs() + (point.y - drag.origin.y).abs()
                < PILL_DRAG_THRESHOLD
        {
            return;
        }
        drag.moved = true;
        self.pill_drag = Some(drag);
        let Some(display) = self.display else {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::NoDisplay));
            return;
        };
        Self::emit_native(self.native.move_pill(display, point), effects);
        self.pill_spot = self.native.pill_spot();
    }

    fn end_pill_drag(&mut self, effects: &mut Vec<OverlayEffect>) {
        let Some(drag) = self.pill_drag.take() else {
            return;
        };
        if !drag.moved {
            self.expand_pill(effects);
        }
    }

    fn expand_pill(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.state.surface != OverlaySurface::Pill {
            return;
        }
        let Some(display) = self.display else {
            effects.push(OverlayEffect::Unavailable(OverlayRuntimeIssue::NoDisplay));
            return;
        };
        Self::emit_native(self.native.expand_pill(display), effects);
        self.sync_surface();
        self.focus = OverlayFocus::QuickAsk;
    }

    fn dismiss_pill(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.state.surface != OverlaySurface::Pill || self.state.busy {
            return;
        }
        self.cancel_timer(OverlayTimer::PillLinger, effects);
        self.cancel_timer(OverlayTimer::PillFade, effects);
        self.state.pill_leaving = false;
        Self::emit_native(self.native.close_overlay(), effects);
        self.focus = OverlayFocus::Workspace;
        effects.push(OverlayEffect::RestoreFocus);
    }

    fn select_orb(&mut self, command: SharedString, effects: &mut Vec<OverlayEffect>) {
        Self::emit_native(
            self.native.handle_escape(NativeWindowRole::RadialCommands),
            effects,
        );
        if self
            .state
            .commands
            .iter()
            .find(|entry| entry.id == command)
            .is_some_and(|entry| entry.disabled)
        {
            return;
        }
        self.run_command(command, effects);
    }

    fn annotation_begin(&mut self, point: AnnotationPoint, effects: &mut Vec<OverlayEffect>) {
        if self.annotation.display_id.is_none() {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::MissingAnnotation,
            ));
            return;
        }
        let Some(point) = self.clamp_annotation_point(point) else {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::InvalidPoint,
            ));
            return;
        };
        if self.annotation.state.strokes.len() == MAX_ANNOTATION_STROKES {
            return;
        }
        self.annotation.state.error = None;
        self.annotation.state.strokes.push(AnnotationStroke {
            points: vec![point],
        });
        self.annotation.state.drawn = true;
        self.annotation.capture_pending = false;
        self.cancel_timer(OverlayTimer::AnnotationSettle, effects);
    }

    fn annotation_draw(&mut self, point: AnnotationPoint, effects: &mut Vec<OverlayEffect>) {
        let Some(point) = self.clamp_annotation_point(point) else {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::InvalidPoint,
            ));
            return;
        };
        let Some(stroke) = self.annotation.state.strokes.last_mut() else {
            return;
        };
        if stroke.points.len() < MAX_ANNOTATION_POINTS {
            stroke.points.push(point);
        }
        self.annotation.state.drawn = true;
        self.annotation.capture_pending = false;
        self.cancel_timer(OverlayTimer::AnnotationSettle, effects);
    }

    fn annotation_end(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.annotation.state.drawn {
            self.schedule_timer(
                OverlayTimer::AnnotationSettle,
                ANNOTATION_SETTLE_MS,
                effects,
            );
        }
    }

    fn finish_annotation(&mut self, effects: &mut Vec<OverlayEffect>) {
        if !self.annotation.state.drawn {
            return;
        }
        self.cancel_timer(OverlayTimer::AnnotationSettle, effects);
        self.request_annotation_capture(effects);
    }

    fn cancel_annotation(&mut self, effects: &mut Vec<OverlayEffect>) {
        self.cancel_timer(OverlayTimer::AnnotationSettle, effects);
        self.annotation = AnnotationRuntimeState::default();
        self.annotation.state.reduced_motion = self.config.reduced_motion;
        Self::emit_native(self.native.cancel_annotation(), effects);
        self.focus = OverlayFocus::QuickAsk;
    }

    fn request_annotation_capture(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.annotation.capture_pending || self.annotation.state.strokes.is_empty() {
            return;
        }
        self.annotation.capture_pending = true;
        self.set_native_annotation_phase(AnnotationWindowPhase::Saving);
        effects.push(OverlayEffect::Service(
            OverlayServiceEffect::CaptureAnnotationFrame {
                strokes: self.annotation.state.strokes.clone(),
            },
        ));
    }

    fn set_native_annotation_phase(&mut self, phase: AnnotationWindowPhase) {
        self.native.set_annotation_phase(phase);
    }

    fn clamp_annotation_point(&self, point: AnnotationPoint) -> Option<AnnotationPoint> {
        if !point.x.is_finite()
            || !point.y.is_finite()
            || point.x.abs() > MAX_ANNOTATION_COORDINATE
            || point.y.abs() > MAX_ANNOTATION_COORDINATE
        {
            return None;
        }
        let bounds = self.annotation.bounds?;
        Some(AnnotationPoint {
            x: point.x.clamp(0., bounds.width),
            y: point.y.clamp(0., bounds.height),
        })
    }

    fn start_computer(
        &mut self,
        display: NativeDisplay,
        request: ComputerRunRequest,
        effects: &mut Vec<OverlayEffect>,
    ) {
        self.finish_computer_windows(effects);
        self.computer = Some(ComputerRuntimeState {
            display_id: display.id,
            request: request.clone(),
            progress: ComputerProgress::default(),
            active: true,
            cursor_ready: false,
            cursor_visible_until_ms: None,
        });
        Self::emit_native(self.native.open_run_banner(display, request), effects);
        self.focus = OverlayFocus::ComputerRunBanner;
    }

    fn computer_ready(&mut self, effects: &mut Vec<OverlayEffect>) {
        let Some(computer) = self.computer.as_mut() else {
            return;
        };
        computer.cursor_ready = true;
        self.native.set_computer_cursor_ready(true);
        let progress = computer.progress.clone();
        Self::emit_native(
            self.native.update_computer_progress(&progress, self.now_ms),
            effects,
        );
    }

    fn update_computer(&mut self, progress: ComputerProgress, effects: &mut Vec<OverlayEffect>) {
        if !progress.valid() {
            effects.push(OverlayEffect::Unavailable(
                OverlayRuntimeIssue::InvalidComputerProgress,
            ));
            return;
        }
        let Some(computer) = self.computer.as_mut() else {
            return;
        };
        if !computer.active {
            return;
        }
        computer.progress = progress.clone();
        if progress.cursor.is_some() {
            computer.cursor_visible_until_ms =
                Some(self.now_ms.saturating_add(COMPUTER_CURSOR_LIFETIME_MS));
            self.schedule_timer(
                OverlayTimer::ComputerCursor,
                COMPUTER_CURSOR_LIFETIME_MS,
                effects,
            );
        }
        Self::emit_native(
            self.native.update_computer_progress(&progress, self.now_ms),
            effects,
        );
    }

    fn finish_computer(
        &mut self,
        thread_id: SharedString,
        error: Option<SharedString>,
        effects: &mut Vec<OverlayEffect>,
    ) {
        let matches = self
            .computer
            .as_ref()
            .is_some_and(|computer| computer.request.thread_id == thread_id);
        if !matches {
            return;
        }
        self.finish_computer_windows(effects);
        if let Some(error) = error {
            self.state.error = Some(bounded_shared(&error, 2_048));
        }
        self.computer = None;
    }

    fn stop_computer(&mut self, effects: &mut Vec<OverlayEffect>) {
        let Some(thread_id) = self
            .computer
            .as_ref()
            .map(|computer| computer.request.thread_id.clone())
        else {
            return;
        };
        effects.push(OverlayEffect::Service(
            OverlayServiceEffect::StopComputerRun(thread_id),
        ));
        self.finish_computer_windows(effects);
        self.computer = None;
    }

    fn finish_computer_windows(&mut self, effects: &mut Vec<OverlayEffect>) {
        self.cancel_timer(OverlayTimer::ComputerCursor, effects);
        Self::emit_native(self.native.close_run_banner(), effects);
        if self.focus == OverlayFocus::ComputerRunBanner
            || self.focus == OverlayFocus::ComputerActivityCursor
        {
            self.focus = OverlayFocus::Workspace;
            effects.push(OverlayEffect::RestoreFocus);
        }
    }

    fn window_closed(&mut self, role: NativeWindowRole, effects: &mut Vec<OverlayEffect>) {
        Self::emit_native(self.native.mark_closed(role), effects);
        match role {
            NativeWindowRole::QuickAsk => {
                self.reset_overlay_state();
                self.focus = OverlayFocus::Workspace;
                self.cancel_timer(OverlayTimer::NotchWave, effects);
                effects.push(OverlayEffect::RestoreFocus);
            }
            NativeWindowRole::ScreenAnnotation => {
                self.annotation = AnnotationRuntimeState::default();
                self.annotation.state.reduced_motion = self.config.reduced_motion;
                self.focus = OverlayFocus::QuickAsk;
            }
            NativeWindowRole::NotchHotspot => self.focus = OverlayFocus::None,
            NativeWindowRole::RadialCommands => {
                if self.focus == OverlayFocus::RadialCommands {
                    self.focus = OverlayFocus::QuickAsk;
                }
            }
            NativeWindowRole::ComputerRunBanner => {
                self.computer = None;
                self.focus = OverlayFocus::Workspace;
            }
            NativeWindowRole::ComputerActivityCursor | NativeWindowRole::Workspace => {}
        }
    }

    fn window_blurred(&mut self, role: NativeWindowRole, effects: &mut Vec<OverlayEffect>) {
        if role != NativeWindowRole::QuickAsk || self.annotation.display_id.is_some() {
            return;
        }
        let Some(display) = self.display else {
            return;
        };
        Self::emit_native(self.native.leave_overlay(display), effects);
        self.sync_surface();
        if self.state.surface == OverlaySurface::Pill {
            self.focus = OverlayFocus::QuickAsk;
        } else {
            self.focus = OverlayFocus::Workspace;
            effects.push(OverlayEffect::RestoreFocus);
        }
    }

    fn escape(&mut self, role: Option<NativeWindowRole>, effects: &mut Vec<OverlayEffect>) {
        if self.state.slash_open {
            self.dismiss_slash();
            return;
        }
        if self.state.models_open || self.state.modes_open || self.state.source_menu_open {
            self.state.models_open = false;
            self.state.modes_open = false;
            self.state.source_menu_open = false;
            self.focus = OverlayFocus::QuickAsk;
            return;
        }
        match role.or_else(|| self.focus.role()) {
            Some(NativeWindowRole::ScreenAnnotation) => self.cancel_annotation(effects),
            Some(NativeWindowRole::ComputerRunBanner) => self.stop_computer(effects),
            Some(NativeWindowRole::NotchHotspot) => {
                Self::emit_native(self.native.close_hotspot(), effects)
            }
            Some(NativeWindowRole::RadialCommands) => {
                Self::emit_native(
                    self.native.handle_escape(NativeWindowRole::RadialCommands),
                    effects,
                );
                self.focus = OverlayFocus::QuickAsk;
            }
            Some(NativeWindowRole::QuickAsk) => {
                Self::emit_native(
                    self.native.handle_escape(NativeWindowRole::QuickAsk),
                    effects,
                );
                self.sync_surface();
                if self.state.surface == OverlaySurface::Pill {
                    self.focus = OverlayFocus::QuickAsk;
                } else {
                    self.focus = OverlayFocus::Workspace;
                    effects.push(OverlayEffect::RestoreFocus);
                }
            }
            Some(NativeWindowRole::Workspace)
            | Some(NativeWindowRole::ComputerActivityCursor)
            | None => {}
        }
    }

    fn poll_hotspot(
        &mut self,
        display: NativeDisplay,
        notch: Option<NotchGeometry>,
        cursor: GeometryPoint,
        effects: &mut Vec<OverlayEffect>,
    ) {
        let overlay_open = self.native.is_present(NativeWindowRole::QuickAsk);
        let commands = self.native.poll_hotspot(HotspotPollRequest {
            display,
            notch,
            cursor,
            overlay_open,
        });
        let warm = notch.is_some()
            && !overlay_open
            && crate::overlay_surfaces::near_bounds(
                crate::overlay_surfaces::hotspot_layout(display.geometry, notch.unwrap()).bounds,
                cursor,
                crate::native_windows::HOTSPOT_WARM,
            );
        Self::emit_native(commands, effects);
        self.hotspot_hovering = self.native.hotspot_hovering();
        self.schedule_timer(
            OverlayTimer::HotspotPoll,
            crate::overlay_surfaces::hotspot_poll_delay(warm),
            effects,
        );
    }

    fn open_radial(
        &mut self,
        display: NativeDisplay,
        cursor: GeometryPoint,
        effects: &mut Vec<OverlayEffect>,
    ) {
        Self::emit_native(self.native.open_radial(display, cursor), effects);
        self.focus = OverlayFocus::RadialCommands;
    }

    fn set_slash_context(
        &mut self,
        query: Option<SharedString>,
        matches: Vec<SlashItem>,
        active: usize,
        start: usize,
        end: usize,
        sigil: char,
    ) {
        self.state.slash_query = query.map(|value| bounded_shared(&value, 256));
        self.state.slash_matches = bounded_items(matches, MAX_SLASH_MATCHES);
        self.state.slash_active = active.min(self.state.slash_matches.len().saturating_sub(1));
        self.state.slash_open = self.state.slash_query.is_some();
        self.slash_range = self.state.slash_open.then_some((start, end, sigil));
    }

    fn append_dictation(&mut self, text: SharedString) {
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let next = if self.state.message.trim().is_empty() {
            text.to_owned()
        } else {
            format!("{} {text}", self.state.message.trim_end())
        };
        self.set_message(next.into());
    }

    fn advance_to(&mut self, now_ms: u64, effects: &mut Vec<OverlayEffect>) {
        if now_ms < self.now_ms {
            return;
        }
        self.now_ms = now_ms;
        while let Some((&timer, &_at_ms)) = self.timers.iter().find(|(_, at_ms)| **at_ms <= now_ms)
        {
            self.timers.remove(&timer);
            self.fire_timer(timer, effects);
        }
    }

    fn fire_timer(&mut self, timer: OverlayTimer, effects: &mut Vec<OverlayEffect>) {
        match timer {
            OverlayTimer::NotchWave => {
                if !self.config.reduced_motion
                    && self.native.is_present(NativeWindowRole::QuickAsk)
                    && self.state.surface == OverlaySurface::Notch
                {
                    self.notch_wave_frame = self.notch_wave_frame.saturating_add(1);
                    self.schedule_wave(effects);
                }
            }
            OverlayTimer::HotspotPoll => {
                if let (Some(display), Some(cursor)) = (self.display, self.cursor) {
                    self.poll_hotspot(display, self.notch_geometry, cursor, effects);
                }
            }
            OverlayTimer::PillLinger => {
                if self.state.surface == OverlaySurface::Pill
                    && self.state.pill_status == PillStatus::Done
                    && !self.state.busy
                {
                    self.state.pill_leaving = true;
                    self.schedule_timer(OverlayTimer::PillFade, PILL_FADE_MS, effects);
                }
            }
            OverlayTimer::PillFade => {
                if self.state.pill_leaving {
                    self.state.pill_leaving = false;
                    Self::emit_native(self.native.close_overlay(), effects);
                }
            }
            OverlayTimer::AnnotationSettle => self.request_annotation_capture(effects),
            OverlayTimer::ComputerCursor => {
                if let Some(computer) = self.computer.as_mut() {
                    computer.cursor_visible_until_ms = None;
                }
                Self::emit_native(self.native.hide_computer_cursor(), effects);
            }
        }
    }

    fn schedule_wave(&mut self, effects: &mut Vec<OverlayEffect>) {
        if self.config.reduced_motion {
            return;
        }
        let delay = if self.state.busy {
            NOTCH_WAVE_BUSY_MS
        } else {
            NOTCH_WAVE_IDLE_MS
        };
        self.schedule_timer(OverlayTimer::NotchWave, delay, effects);
    }

    fn schedule_timer(
        &mut self,
        timer: OverlayTimer,
        delay_ms: u64,
        effects: &mut Vec<OverlayEffect>,
    ) {
        let delay_ms = match timer {
            OverlayTimer::PillLinger | OverlayTimer::PillFade | OverlayTimer::AnnotationSettle
                if self.config.reduced_motion =>
            {
                0
            }
            _ => delay_ms,
        };
        let at_ms = self.now_ms.saturating_add(delay_ms);
        self.timers.insert(timer, at_ms);
        effects.push(OverlayEffect::ScheduleTimer { timer, at_ms });
    }

    fn cancel_timer(&mut self, timer: OverlayTimer, effects: &mut Vec<OverlayEffect>) {
        if self.timers.remove(&timer).is_some() {
            effects.push(OverlayEffect::CancelTimer(timer));
        }
    }

    fn emit_native(commands: Vec<NativeWindowCommand>, effects: &mut Vec<OverlayEffect>) {
        effects.extend(commands.into_iter().map(OverlayEffect::Native));
    }

    fn sync_surface(&mut self) {
        self.state.surface = self.native.overlay_surface();
        self.state.notch = self.notch_placement();
        self.pill_spot = self.native.pill_spot();
    }

    fn notch_placement(&self) -> NotchPlacement {
        let Some(display) = self.display else {
            return self.state.notch;
        };
        if self.state.surface != OverlaySurface::Notch {
            return NotchPlacement {
                left: 0.,
                width: 0.,
                height: 0.,
            };
        }
        overlay_layout(display.geometry, self.config.notch_gap, self.notch_geometry).notch
    }

    fn overlay_bounds(&self, display: NativeDisplay) -> SurfaceRect {
        match self.state.surface {
            OverlaySurface::Notch => {
                overlay_layout(display.geometry, self.config.notch_gap, self.notch_geometry).bounds
            }
            OverlaySurface::Pill => pill_layout(display.geometry, self.pill_spot),
            OverlaySurface::Popout => {
                let pill = self.pill_spot.unwrap_or_else(|| {
                    let bounds = pill_layout(display.geometry, None);
                    GeometryPoint {
                        x: bounds.x,
                        y: bounds.y,
                    }
                });
                crate::overlay_surfaces::popout_layout(display.geometry, pill, self.state.grow)
                    .bounds
            }
        }
    }

    fn working_label(&self) -> SharedString {
        self.state
            .stream
            .steps
            .iter()
            .rev()
            .find(|step| step.status.as_ref() == "pending" || step.status.as_ref() == "in_progress")
            .map(|step| step.title.clone())
            .unwrap_or_else(|| SharedString::new_static("Working"))
    }

    fn reset_overlay_state(&mut self) {
        let notch = self.state.notch;
        let model_options = mem::take(&mut self.state.model_options);
        self.state = OverlayState::default();
        self.state.surface = if self.config.platform.is_windows() {
            OverlaySurface::Pill
        } else {
            OverlaySurface::Notch
        };
        self.state.notch = notch;
        self.state.model_options = model_options;
        self.state.reduced_motion = self.config.reduced_motion;
        self.pending_message = None;
        self.pill_drag = None;
        self.annotation = AnnotationRuntimeState::default();
        self.annotation.state.reduced_motion = self.config.reduced_motion;
    }
}

fn bounded_notch_gap(value: f32) -> f32 {
    if value.is_finite() {
        value.round().clamp(NOTCH_GAP_MIN, NOTCH_GAP_MAX)
    } else {
        180.
    }
}

fn bounded_shared(value: &str, max_chars: usize) -> SharedString {
    value.chars().take(max_chars).collect::<String>().into()
}

fn valid_geometry_point(point: GeometryPoint) -> Option<GeometryPoint> {
    (point.x.is_finite()
        && point.y.is_finite()
        && point.x.abs() <= 100_000.
        && point.y.abs() <= 100_000.)
        .then_some(point)
}

fn bounded_items(items: Vec<SlashItem>, max: usize) -> Vec<SlashItem> {
    items
        .into_iter()
        .take(max)
        .map(|mut item| {
            item.id = bounded_shared(&item.id, 128);
            item.name = bounded_shared(&item.name, 256);
            item.kind = bounded_shared(&item.kind, 64);
            item.detail = bounded_shared(&item.detail, 512);
            item
        })
        .collect()
}

fn bounded_settings_page(value: &str) -> Option<SharedString> {
    (value.chars().count() <= 16
        && !value.is_empty()
        && value
            .chars()
            .all(|character| character.is_ascii_lowercase()))
    .then(|| value.to_owned().into())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::overlay_surfaces::DisplayGeometry;

    fn display() -> NativeDisplay {
        NativeDisplay::new(
            7,
            DisplayGeometry {
                bounds: SurfaceRect::new(0., 0., 1380., 860.),
                work_area: SurfaceRect::new(0., 24., 1380., 836.),
            },
        )
    }

    fn notch() -> NotchGeometry {
        NotchGeometry {
            id: 7.,
            x: 600.,
            width: 180.,
            height: 32.,
        }
    }

    fn runtime() -> OverlayRuntime {
        let mut runtime = OverlayRuntime::new(OverlayRuntimeConfig {
            platform: NativeHostPlatform::MacOS,
            ..OverlayRuntimeConfig::default()
        });
        runtime.set_display(display(), Some(notch()), 0);
        runtime
    }

    #[test]
    fn configuration_clamps_untrusted_notch_gap() {
        let mut config = OverlayRuntimeConfig::default();
        config.set_notch_gap(f32::NAN);
        assert_eq!(config.notch_gap, 180.);
        config.set_notch_gap(10.);
        assert_eq!(config.notch_gap, NOTCH_GAP_MIN);
        config.set_notch_gap(500.);
        assert_eq!(config.notch_gap, NOTCH_GAP_MAX);
    }

    #[test]
    fn open_overlay_uses_exact_notch_geometry_and_focus() {
        let mut runtime = runtime();
        let output = runtime.dispatch_action(OverlayAction::OpenOverlay, 1);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::Open(spec))
                if spec.role == NativeWindowRole::QuickAsk
                    && spec.bounds == SurfaceRect::new(380., 0., 620., 255.)
        )));
        assert_eq!(runtime.focus, OverlayFocus::QuickAsk);
        assert_eq!(runtime.state.surface, OverlaySurface::Notch);
        assert_eq!(runtime.state.notch.width, 180.);
    }

    #[test]
    fn submit_is_bounded_and_emits_acp_effect_once() {
        let mut runtime = runtime();
        let output = runtime.dispatch_action(
            OverlayAction::Submit("x".repeat(MAX_OVERLAY_MESSAGE_CHARS + 50).into()),
            4,
        );
        let Some(OverlayEffect::Acp(OverlayAcpEffect::Submit { text, .. })) =
            output.effects.first()
        else {
            panic!()
        };
        assert_eq!(text.chars().count(), MAX_OVERLAY_MESSAGE_CHARS);
        assert!(runtime.state.busy);
        assert_eq!(runtime.state.turns.len(), 1);
    }

    #[test]
    fn migration_requires_six_turns_and_is_available_at_threshold() {
        let mut runtime = runtime();
        assert!(
            runtime
                .dispatch_action(OverlayAction::MigrateToWorkspace, 1)
                .effects
                .iter()
                .any(|effect| matches!(
                    effect,
                    OverlayEffect::Unavailable(OverlayRuntimeIssue::MigrationNotReady)
                ))
        );
        for _ in 0..MIGRATE_AFTER {
            runtime.append_turn(OverlayTurn::user("turn"));
        }
        let output = runtime.dispatch_action(OverlayAction::MigrateToWorkspace, 2);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::OpenWorkspace(None))
        )));
    }

    #[test]
    fn done_pill_lingers_then_fades_and_closes_at_exact_constants() {
        let mut runtime = OverlayRuntime::new(OverlayRuntimeConfig {
            platform: NativeHostPlatform::Windows,
            ..OverlayRuntimeConfig::default()
        });
        runtime.set_display(display(), None, 0);
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        runtime.dispatch(OverlayInput::SetBusy {
            busy: true,
            now_ms: 1,
        });
        let output = runtime.dispatch(OverlayInput::SetBusy {
            busy: false,
            now_ms: 2,
        });
        assert!(output.effects.iter().any(|effect| match effect {
            OverlayEffect::ScheduleTimer { timer, at_ms } => {
                *timer == OverlayTimer::PillLinger && *at_ms == 2 + PILL_LINGER_MS
            }
            _ => false,
        }));
        runtime.tick(2 + PILL_LINGER_MS);
        assert!(runtime.state.pill_leaving);
        assert_eq!(
            runtime
                .timer(OverlayTimer::PillFade)
                .map(|timer| timer.at_ms),
            Some(2 + PILL_LINGER_MS + PILL_FADE_MS)
        );
    }

    #[test]
    fn pill_drag_threshold_matches_electron_click_behavior() {
        let mut runtime = OverlayRuntime::new(OverlayRuntimeConfig {
            platform: NativeHostPlatform::Windows,
            ..OverlayRuntimeConfig::default()
        });
        runtime.set_display(display(), None, 0);
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        runtime.dispatch_action(
            OverlayAction::BeginPillDrag(GeometryPoint { x: 100., y: 100. }),
            1,
        );
        runtime.dispatch_action(
            OverlayAction::MovePill(GeometryPoint { x: 101., y: 101. }),
            2,
        );
        let output = runtime.dispatch_action(OverlayAction::EndPillDrag, 3);
        assert!(
            output.effects.iter().any(|effect| matches!(
                effect,
                OverlayEffect::Native(NativeWindowCommand::SetBounds { .. })
            )) || runtime.state.surface == OverlaySurface::Popout
        );
    }

    #[test]
    fn slash_pick_replaces_fragment_and_closes_menu() {
        let mut runtime = runtime();
        runtime.state.message = "ask /hel please".into();
        runtime.dispatch(OverlayInput::SetSlashContext {
            query: Some("hel".into()),
            matches: vec![SlashItem {
                id: "help".into(),
                name: "help".into(),
                kind: "builtin".into(),
                detail: "Help".into(),
            }],
            active: 0,
            start: 4,
            end: 8,
            sigil: '/',
        });
        runtime.dispatch_action(OverlayAction::PickSlash("help".into()), 1);
        assert_eq!(runtime.state.message.as_ref(), "ask /help please");
        assert!(!runtime.state.slash_open);
    }

    #[test]
    fn annotation_settles_after_exact_delay_and_clamps_points() {
        let mut runtime = runtime();
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        runtime.dispatch_action(OverlayAction::StartDrawing, 1);
        runtime.dispatch_action(
            OverlayAction::AnnotationBegin(AnnotationPoint { x: -5., y: 900. }),
            2,
        );
        runtime.dispatch_action(OverlayAction::AnnotationEnd, 3);
        assert_eq!(
            runtime
                .timer(OverlayTimer::AnnotationSettle)
                .map(|timer| timer.at_ms),
            Some(3 + ANNOTATION_SETTLE_MS)
        );
        assert_eq!(
            runtime.annotation.state.strokes[0].points[0],
            AnnotationPoint { x: 0., y: 860. }
        );
        let output = runtime.tick(3 + ANNOTATION_SETTLE_MS);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Service(OverlayServiceEffect::CaptureAnnotationFrame { .. })
        )));
    }

    #[test]
    fn computer_cursor_has_exact_lifetime_and_stop_effect() {
        let mut runtime = runtime();
        let request = ComputerRunRequest::new("thread", "Inspect the front app");
        runtime.dispatch(OverlayInput::StartComputer {
            display: display(),
            request: request.clone(),
            now_ms: 10,
        });
        runtime.dispatch(OverlayInput::ComputerReady);
        let progress = ComputerProgress {
            cursor: Some(crate::overlay_surfaces::ComputerCursor {
                window_id: 1,
                bounds: SurfaceRect::new(0., 0., 800., 600.),
                x: 30.,
                y: 40.,
            }),
            ..ComputerProgress::default()
        };
        runtime.dispatch(OverlayInput::ComputerProgress {
            progress,
            now_ms: 20,
        });
        assert_eq!(
            runtime
                .timer(OverlayTimer::ComputerCursor)
                .map(|timer| timer.at_ms),
            Some(20 + COMPUTER_CURSOR_LIFETIME_MS)
        );
        let output = runtime.dispatch_action(OverlayAction::StopComputerRun, 21);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Service(OverlayServiceEffect::StopComputerRun(id)) if id == "thread"
        )));
        assert!(runtime.computer.is_none());
    }

    #[test]
    fn reduced_motion_removes_wave_and_collapses_visual_timers() {
        let mut runtime = runtime();
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        runtime.dispatch(OverlayInput::SetReducedMotion(true));
        assert!(runtime.timer(OverlayTimer::NotchWave).is_none());
        runtime.state.surface = OverlaySurface::Pill;
        runtime.state.pill_status = PillStatus::Done;
        runtime.dispatch(OverlayInput::SetBusy {
            busy: true,
            now_ms: 1,
        });
        let output = runtime.dispatch(OverlayInput::SetBusy {
            busy: false,
            now_ms: 2,
        });
        assert!(output.effects.iter().any(|effect| match effect {
            OverlayEffect::ScheduleTimer { timer, at_ms } => {
                *timer == OverlayTimer::PillLinger && *at_ms == 2
            }
            _ => false,
        }));
    }

    #[test]
    fn hotspot_poll_preserves_warm_and_cold_delays() {
        let mut runtime = runtime();
        let output = runtime.dispatch(OverlayInput::HotspotPoll {
            display: display(),
            notch: Some(notch()),
            cursor: GeometryPoint { x: 600., y: 0. },
            now_ms: 0,
        });
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::ScheduleTimer {
                timer: OverlayTimer::HotspotPoll,
                at_ms: 120
            }
        )));
        let output = runtime.dispatch(OverlayInput::HotspotPoll {
            display: display(),
            notch: Some(notch()),
            cursor: GeometryPoint { x: 0., y: 500. },
            now_ms: 120,
        });
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::ScheduleTimer {
                timer: OverlayTimer::HotspotPoll,
                at_ms: 370
            }
        )));
    }

    #[test]
    fn growth_and_notch_gap_reflow_emit_current_bounds() {
        let mut runtime = runtime();
        runtime.notch_geometry = None;
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        let output = runtime.dispatch(OverlayInput::SetGrowth(40.));
        assert_eq!(runtime.state.grow, 40.);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::SetBounds { bounds, .. })
                if *bounds == SurfaceRect::new(380., 0., 620., 287.)
        )));
        let output = runtime.dispatch(OverlayInput::SetNotchGap(220.));
        assert_eq!(runtime.config().notch_gap, 220.);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::UpdateQuickAskSurface { notch, .. })
                if notch.width == 220.
        )));
    }

    #[test]
    fn screen_capture_attachment_reveals_overlay_and_sends_context() {
        let mut runtime = runtime();
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        let output = runtime.dispatch_action(OverlayAction::CaptureScreen, 1);
        assert!(runtime.native.capturing());
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Service(OverlayServiceEffect::CaptureScreen)
        )));
        let attachment = AnnotationAttachment {
            id: "capture-1".into(),
            image: Some("data:image/jpeg;base64,abc".into()),
            source_application: Some("Safari".into()),
        };
        let output = runtime.dispatch(OverlayInput::SetAnnotation(Some(attachment.clone())));
        assert_eq!(runtime.state.annotation, Some(attachment));
        assert!(!runtime.native.capturing());
        assert_eq!(runtime.focus, OverlayFocus::QuickAsk);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::SendScreenContext)
        )));
    }

    #[test]
    fn annotation_capture_completion_closes_canvas_and_restores_quick_ask() {
        let mut runtime = runtime();
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        runtime.dispatch_action(OverlayAction::StartDrawing, 1);
        runtime.dispatch_action(
            OverlayAction::AnnotationBegin(AnnotationPoint { x: 10., y: 20. }),
            2,
        );
        let output = runtime.dispatch(OverlayInput::AnnotationCaptured(AnnotationAttachment {
            id: "annotated-1".into(),
            image: None,
            source_application: None,
        }));
        assert!(runtime.annotation.display_id.is_none());
        assert_eq!(runtime.focus, OverlayFocus::QuickAsk);
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::Close {
                role: NativeWindowRole::ScreenAnnotation
            })
        )));
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Native(NativeWindowCommand::SendScreenContext)
        )));
    }

    #[test]
    fn escape_closes_nested_menus_before_dismissing_overlay() {
        let mut runtime = runtime();
        runtime.dispatch_action(OverlayAction::OpenOverlay, 0);
        runtime.state.slash_open = true;
        runtime.state.models_open = true;
        runtime.state.source_menu_open = true;
        runtime.dispatch(OverlayInput::Escape {
            role: Some(NativeWindowRole::QuickAsk),
            now_ms: 1,
        });
        assert!(!runtime.state.slash_open);
        assert!(runtime.state.models_open);
        runtime.dispatch(OverlayInput::Escape {
            role: Some(NativeWindowRole::QuickAsk),
            now_ms: 2,
        });
        assert!(!runtime.state.models_open);
        assert!(!runtime.state.source_menu_open);
        assert_eq!(runtime.focus, OverlayFocus::QuickAsk);
    }

    #[test]
    fn invalid_computer_progress_fails_closed() {
        let mut runtime = runtime();
        runtime.dispatch(OverlayInput::StartComputer {
            display: display(),
            request: ComputerRunRequest::new("thread", "task"),
            now_ms: 1,
        });
        let mut progress = ComputerProgress::default();
        progress.actions = 21;
        let output = runtime.dispatch(OverlayInput::ComputerProgress {
            progress,
            now_ms: 2,
        });
        assert!(output.effects.iter().any(|effect| matches!(
            effect,
            OverlayEffect::Unavailable(OverlayRuntimeIssue::InvalidComputerProgress)
        )));
    }
}
