use std::{fmt, time::Duration};

use gpui::{
    AnyWindowHandle, App, Bounds, DisplayId, Entity, Pixels, PlatformDisplay, Render, SharedString,
    TitlebarOptions, Window, WindowBackgroundAppearance, WindowBounds, WindowDecorations,
    WindowHandle, WindowKind, WindowOptions, point, px, size,
};

use crate::{
    navigation::OverlaySurface,
    overlay_surfaces::{
        ANNOTATION_SETTLE_MS, COMPUTER_CURSOR_LIFETIME_MS, ComputerProgress, DisplayGeometry,
        GeometryPoint, NotchGeometry, NotchPlacement, PILL_FADE_MS, PILL_LINGER_MS, SurfaceRect,
        hotspot_layout, hotspot_poll_delay, near_bounds, overlay_growth, overlay_layout,
        pill_layout, popout_layout, radial_window_layout,
    },
};

pub const WORKSPACE_WIDTH: f32 = 1380.;
pub const WORKSPACE_HEIGHT: f32 = 860.;
pub const WORKSPACE_MIN_WIDTH: f32 = 1040.;
pub const WORKSPACE_MIN_HEIGHT: f32 = 680.;
pub const HOTSPOT_WARM: f32 = 220.;
pub const RUN_BANNER_WIDTH: f32 = 520.;
pub const RUN_BANNER_HEIGHT: f32 = 76.;
pub const RUN_BANNER_MARGIN: f32 = 16.;
pub const RUN_BANNER_SIDE_MARGIN: f32 = 40.;
pub const MAX_RUN_STEPS: u32 = 20;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeHostPlatform {
    MacOS,
    Windows,
    #[default]
    Other,
}

impl NativeHostPlatform {
    pub const fn is_macos(self) -> bool {
        matches!(self, Self::MacOS)
    }

    pub const fn is_windows(self) -> bool {
        matches!(self, Self::Windows)
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Hash)]
pub enum NativeWindowRole {
    Workspace,
    QuickAsk,
    ScreenAnnotation,
    NotchHotspot,
    RadialCommands,
    ComputerRunBanner,
    ComputerActivityCursor,
}

impl NativeWindowRole {
    pub const ALL: [Self; 7] = [
        Self::Workspace,
        Self::QuickAsk,
        Self::ScreenAnnotation,
        Self::NotchHotspot,
        Self::RadialCommands,
        Self::ComputerRunBanner,
        Self::ComputerActivityCursor,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::QuickAsk => "quick-ask",
            Self::ScreenAnnotation => "screen-annotation",
            Self::NotchHotspot => "notch-hotspot",
            Self::RadialCommands => "radial-commands",
            Self::ComputerRunBanner => "computer-run-banner",
            Self::ComputerActivityCursor => "computer-activity-cursor",
        }
    }

    const fn index(self) -> usize {
        match self {
            Self::Workspace => 0,
            Self::QuickAsk => 1,
            Self::ScreenAnnotation => 2,
            Self::NotchHotspot => 3,
            Self::RadialCommands => 4,
            Self::ComputerRunBanner => 5,
            Self::ComputerActivityCursor => 6,
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NativeWindowPhase {
    #[default]
    Closed,
    Opening,
    Visible,
    Hidden,
    WaitingForIdle,
    Closing,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum QuickAskConcurrency {
    Continue,
    NewSession,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum AnnotationWindowPhase {
    #[default]
    Inactive,
    Capturing,
    Ready,
    Saving,
    Failed,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NativeDisplay {
    pub id: u64,
    pub geometry: DisplayGeometry,
}

impl NativeDisplay {
    pub const fn new(id: u64, geometry: DisplayGeometry) -> Self {
        Self { id, geometry }
    }
}

pub fn display_from_platform(display: &dyn PlatformDisplay) -> NativeDisplay {
    let bounds = display.bounds();
    let work_area = display.visible_bounds();
    NativeDisplay {
        id: u64::from(display.id()),
        geometry: DisplayGeometry {
            bounds: SurfaceRect::new(
                bounds.origin.x.as_f32(),
                bounds.origin.y.as_f32(),
                bounds.size.width.as_f32(),
                bounds.size.height.as_f32(),
            ),
            work_area: SurfaceRect::new(
                work_area.origin.x.as_f32(),
                work_area.origin.y.as_f32(),
                work_area.size.width.as_f32(),
                work_area.size.height.as_f32(),
            ),
        },
    }
}

pub fn workspace_bounds(display: NativeDisplay) -> SurfaceRect {
    let bounds = display.geometry.bounds;
    SurfaceRect::new(
        (bounds.x + (bounds.width - WORKSPACE_WIDTH) * 0.5).round(),
        (bounds.y + (bounds.height - WORKSPACE_HEIGHT) * 0.5).round(),
        WORKSPACE_WIDTH,
        WORKSPACE_HEIGHT,
    )
}

pub fn display_nearest(displays: &[NativeDisplay], point: GeometryPoint) -> Option<NativeDisplay> {
    displays.iter().copied().min_by(|left, right| {
        distance_to_rect(left.geometry.bounds, point)
            .total_cmp(&distance_to_rect(right.geometry.bounds, point))
    })
}

fn distance_to_rect(rect: SurfaceRect, point: GeometryPoint) -> f32 {
    let dx = if point.x < rect.x {
        rect.x - point.x
    } else if point.x > rect.right() {
        point.x - rect.right()
    } else {
        0.
    };
    let dy = if point.y < rect.y {
        rect.y - point.y
    } else if point.y > rect.bottom() {
        point.y - rect.bottom()
    } else {
        0.
    };
    dx.mul_add(dx, dy * dy)
}

#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct NativeSize {
    pub width: f32,
    pub height: f32,
}

impl NativeSize {
    pub const fn new(width: f32, height: f32) -> Self {
        Self { width, height }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeWindowRequirement {
    NativeDecorations,
    PopupWindowLevel,
    WindowOrdering,
    AllWorkspaces,
    ProgrammaticBounds,
    HideWindow,
    ShowInactive,
    DestroyWindow,
    MousePassthrough,
    HiddenInMissionControl,
    SkipTaskbar,
    NativeShadow,
    NativeRoundedCorners,
    Focusability,
    MaximizeControl,
    Vibrancy,
    GlobalEscapeShortcut,
    FrontmostApplication,
    DisplayAndNotchGeometry,
    ApplicationActivation,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeWindowTimer {
    HotspotWarm,
    HotspotCold,
    PillLinger,
    PillFade,
    AnnotationSettle,
    ComputerCursor,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NativeWindowFlags {
    pub focus: bool,
    pub show: bool,
    pub movable: bool,
    pub resizable: bool,
    pub minimizable: bool,
    pub maximizable: bool,
    pub focusable: bool,
    pub transparent: bool,
    pub decorated: bool,
    pub always_on_top: bool,
    pub all_workspaces: bool,
    pub click_through: bool,
    pub mouse_events_ignored: bool,
    pub show_inactive: bool,
    pub hidden_in_mission_control: bool,
    pub skip_taskbar: bool,
    pub has_shadow: bool,
    pub rounded_corners: bool,
}

impl NativeWindowFlags {
    fn workspace(platform: NativeHostPlatform) -> Self {
        Self {
            focus: true,
            show: false,
            movable: true,
            resizable: true,
            minimizable: true,
            maximizable: true,
            focusable: true,
            transparent: platform.is_macos(),
            decorated: true,
            always_on_top: false,
            all_workspaces: false,
            click_through: false,
            mouse_events_ignored: false,
            show_inactive: false,
            hidden_in_mission_control: false,
            skip_taskbar: false,
            has_shadow: true,
            rounded_corners: true,
        }
    }

    fn overlay(platform: NativeHostPlatform, focusable: bool) -> Self {
        Self {
            focus: focusable,
            show: false,
            movable: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            focusable,
            transparent: true,
            decorated: false,
            always_on_top: true,
            all_workspaces: platform.is_macos(),
            click_through: false,
            mouse_events_ignored: false,
            show_inactive: true,
            hidden_in_mission_control: false,
            skip_taskbar: true,
            has_shadow: false,
            rounded_corners: false,
        }
    }

    fn computer_cursor() -> Self {
        Self {
            focus: false,
            show: false,
            movable: false,
            resizable: false,
            minimizable: false,
            maximizable: false,
            focusable: false,
            transparent: true,
            decorated: false,
            always_on_top: false,
            all_workspaces: false,
            click_through: true,
            mouse_events_ignored: true,
            show_inactive: true,
            hidden_in_mission_control: true,
            skip_taskbar: true,
            has_shadow: false,
            rounded_corners: false,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeWindowSpec {
    pub role: NativeWindowRole,
    pub bounds: SurfaceRect,
    pub display_id: Option<u64>,
    pub title: Option<SharedString>,
    pub flags: NativeWindowFlags,
    pub titlebar_transparent: bool,
    pub min_size: Option<NativeSize>,
    pub overlay_surface: Option<OverlaySurface>,
    pub notch: Option<NotchPlacement>,
    pub reduced_motion: bool,
    pub initial_command: Option<SharedString>,
    pub thread_id: Option<SharedString>,
    pub task: Option<SharedString>,
    pub max_steps: Option<u32>,
}

impl NativeWindowSpec {
    pub fn workspace(
        display: NativeDisplay,
        platform: NativeHostPlatform,
        reduced_motion: bool,
    ) -> Self {
        Self {
            role: NativeWindowRole::Workspace,
            bounds: workspace_bounds(display),
            display_id: Some(display.id),
            title: Some(SharedString::new_static("Emma")),
            flags: NativeWindowFlags::workspace(platform),
            titlebar_transparent: platform.is_macos(),
            min_size: Some(NativeSize::new(WORKSPACE_MIN_WIDTH, WORKSPACE_MIN_HEIGHT)),
            overlay_surface: None,
            notch: None,
            reduced_motion,
            initial_command: None,
            thread_id: None,
            task: None,
            max_steps: None,
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn quick_ask(
        display: NativeDisplay,
        platform: NativeHostPlatform,
        surface: OverlaySurface,
        notch_gap: f32,
        notch: Option<NotchGeometry>,
        pill_spot: Option<GeometryPoint>,
        grow: f32,
        command: Option<SharedString>,
        reduced_motion: bool,
    ) -> Self {
        let (bounds, notch_placement) = match surface {
            OverlaySurface::Notch => {
                let layout = overlay_layout(display.geometry, notch_gap, notch);
                (layout.bounds, layout.notch)
            }
            OverlaySurface::Pill => (
                pill_layout(display.geometry, pill_spot),
                NotchPlacement {
                    left: 0.,
                    width: 0.,
                    height: 0.,
                },
            ),
            OverlaySurface::Popout => {
                let pill = pill_spot.unwrap_or_else(|| {
                    let bounds = pill_layout(display.geometry, None);
                    GeometryPoint {
                        x: bounds.x,
                        y: bounds.y,
                    }
                });
                let layout = popout_layout(display.geometry, pill, grow);
                (
                    layout.bounds,
                    NotchPlacement {
                        left: 0.,
                        width: 0.,
                        height: 0.,
                    },
                )
            }
        };
        Self {
            role: NativeWindowRole::QuickAsk,
            bounds,
            display_id: Some(display.id),
            title: None,
            flags: NativeWindowFlags::overlay(platform, true),
            titlebar_transparent: false,
            min_size: None,
            overlay_surface: Some(surface),
            notch: Some(notch_placement),
            reduced_motion,
            initial_command: command,
            thread_id: None,
            task: None,
            max_steps: None,
        }
    }

    pub fn screen_annotation(
        display: NativeDisplay,
        platform: NativeHostPlatform,
        reduced_motion: bool,
    ) -> Self {
        let mut flags = NativeWindowFlags::overlay(platform, true);
        flags.movable = false;
        Self {
            role: NativeWindowRole::ScreenAnnotation,
            bounds: display.geometry.bounds,
            display_id: Some(display.id),
            title: None,
            flags,
            titlebar_transparent: false,
            min_size: None,
            overlay_surface: None,
            notch: None,
            reduced_motion,
            initial_command: None,
            thread_id: None,
            task: None,
            max_steps: None,
        }
    }

    pub fn notch_hotspot(
        display: NativeDisplay,
        notch: NotchGeometry,
        platform: NativeHostPlatform,
        reduced_motion: bool,
    ) -> Self {
        let layout = hotspot_layout(display.geometry, notch);
        let mut flags = NativeWindowFlags::overlay(platform, false);
        flags.mouse_events_ignored = true;
        Self {
            role: NativeWindowRole::NotchHotspot,
            bounds: layout.bounds,
            display_id: Some(display.id),
            title: None,
            flags,
            titlebar_transparent: false,
            min_size: None,
            overlay_surface: None,
            notch: Some(layout.notch),
            reduced_motion,
            initial_command: None,
            thread_id: None,
            task: None,
            max_steps: None,
        }
    }

    pub fn radial_commands(
        display: NativeDisplay,
        cursor: GeometryPoint,
        platform: NativeHostPlatform,
        reduced_motion: bool,
    ) -> Self {
        Self {
            role: NativeWindowRole::RadialCommands,
            bounds: radial_window_layout(display.geometry, cursor),
            display_id: Some(display.id),
            title: None,
            flags: NativeWindowFlags::overlay(platform, false),
            titlebar_transparent: false,
            min_size: None,
            overlay_surface: None,
            notch: None,
            reduced_motion,
            initial_command: None,
            thread_id: None,
            task: None,
            max_steps: None,
        }
    }

    pub fn computer_run_banner(
        display: NativeDisplay,
        platform: NativeHostPlatform,
        request: &ComputerRunRequest,
        reduced_motion: bool,
    ) -> Self {
        let area = display.geometry.work_area;
        let width = RUN_BANNER_WIDTH.min((area.width - RUN_BANNER_SIDE_MARGIN).max(0.));
        let bounds = SurfaceRect::new(
            (area.x + (area.width - width) * 0.5).round(),
            area.y + RUN_BANNER_MARGIN,
            width,
            RUN_BANNER_HEIGHT,
        );
        let mut flags = NativeWindowFlags::overlay(platform, false);
        flags.all_workspaces = platform.is_macos();
        Self {
            role: NativeWindowRole::ComputerRunBanner,
            bounds,
            display_id: Some(display.id),
            title: None,
            flags,
            titlebar_transparent: false,
            min_size: None,
            overlay_surface: None,
            notch: None,
            reduced_motion,
            initial_command: None,
            thread_id: Some(request.thread_id.clone()),
            task: Some(request.task.clone()),
            max_steps: Some(request.max_steps.min(MAX_RUN_STEPS)),
        }
    }

    pub fn computer_activity_cursor(_platform: NativeHostPlatform, reduced_motion: bool) -> Self {
        Self {
            role: NativeWindowRole::ComputerActivityCursor,
            bounds: SurfaceRect::new(0., 0., 1., 1.),
            display_id: None,
            title: Some(SharedString::new_static("Emma activity cursor")),
            flags: NativeWindowFlags::computer_cursor(),
            titlebar_transparent: false,
            min_size: None,
            overlay_surface: None,
            notch: None,
            reduced_motion,
            initial_command: None,
            thread_id: None,
            task: None,
            max_steps: None,
        }
    }

    fn gpui_kind(&self) -> WindowKind {
        match self.role {
            NativeWindowRole::Workspace => WindowKind::Normal,
            NativeWindowRole::ScreenAnnotation => WindowKind::Floating,
            NativeWindowRole::ComputerActivityCursor => WindowKind::Normal,
            NativeWindowRole::QuickAsk
            | NativeWindowRole::NotchHotspot
            | NativeWindowRole::RadialCommands
            | NativeWindowRole::ComputerRunBanner => WindowKind::PopUp,
        }
    }

    pub fn gpui_bounds(&self) -> Bounds<Pixels> {
        Bounds {
            origin: point(px(self.bounds.x), px(self.bounds.y)),
            size: size(px(self.bounds.width), px(self.bounds.height)),
        }
    }

    pub fn gpui_options(&self) -> WindowOptions {
        let titlebar = (self.role == NativeWindowRole::Workspace).then(|| TitlebarOptions {
            title: self.title.clone(),
            appears_transparent: self.titlebar_transparent,
            traffic_light_position: (self.titlebar_transparent).then(|| point(px(18.), px(17.))),
        });
        WindowOptions {
            window_bounds: Some(WindowBounds::Windowed(self.gpui_bounds())),
            titlebar,
            focus: self.flags.focus,
            show: self.flags.show,
            kind: self.gpui_kind(),
            is_movable: self.flags.movable,
            app_owns_titlebar_drag: false,
            inactive_frame_interval: if self.reduced_motion {
                Some(Duration::from_millis(250))
            } else {
                WindowOptions::default().inactive_frame_interval
            },
            is_resizable: self.flags.resizable,
            is_minimizable: self.flags.minimizable,
            display_id: self.display_id.map(DisplayId::from),
            window_background: if self.flags.transparent {
                WindowBackgroundAppearance::Transparent
            } else {
                WindowBackgroundAppearance::Opaque
            },
            app_id: None,
            window_min_size: self
                .min_size
                .map(|value| size(px(value.width), px(value.height))),
            window_decorations: (!self.flags.decorated).then_some(WindowDecorations::Client),
            icon: None,
            tabbing_identifier: None,
        }
    }

    pub fn requirements(&self) -> Vec<NativeWindowRequirement> {
        let mut requirements = Vec::new();
        if !self.flags.decorated {
            requirements.push(NativeWindowRequirement::NativeDecorations);
        }
        if self.flags.always_on_top {
            requirements.push(NativeWindowRequirement::PopupWindowLevel);
        }
        if self.flags.all_workspaces {
            requirements.push(NativeWindowRequirement::AllWorkspaces);
        }
        if self.flags.click_through || self.flags.mouse_events_ignored {
            requirements.push(NativeWindowRequirement::MousePassthrough);
        }
        if self.flags.show_inactive {
            requirements.push(NativeWindowRequirement::ShowInactive);
        }
        if self.flags.hidden_in_mission_control {
            requirements.push(NativeWindowRequirement::HiddenInMissionControl);
        }
        if self.flags.skip_taskbar {
            requirements.push(NativeWindowRequirement::SkipTaskbar);
        }
        if !self.flags.has_shadow {
            requirements.push(NativeWindowRequirement::NativeShadow);
        }
        if !self.flags.rounded_corners {
            requirements.push(NativeWindowRequirement::NativeRoundedCorners);
        }
        if !self.flags.focusable {
            requirements.push(NativeWindowRequirement::Focusability);
        }
        if !self.flags.maximizable {
            requirements.push(NativeWindowRequirement::MaximizeControl);
        }
        if self.role == NativeWindowRole::Workspace && self.titlebar_transparent {
            requirements.push(NativeWindowRequirement::Vibrancy);
        }
        if self.role == NativeWindowRole::NotchHotspot
            || (self.role == NativeWindowRole::QuickAsk
                && self.overlay_surface == Some(OverlaySurface::Notch))
        {
            requirements.push(NativeWindowRequirement::DisplayAndNotchGeometry);
        }
        requirements
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct QuickAskRequest {
    pub display: NativeDisplay,
    pub notch_gap: f32,
    pub notch: Option<NotchGeometry>,
    pub pill_spot: Option<GeometryPoint>,
    pub cursor: GeometryPoint,
    pub cursor_orbs_enabled: bool,
    pub concurrency: QuickAskConcurrency,
    pub command: Option<SharedString>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct HotspotPollRequest {
    pub display: NativeDisplay,
    pub notch: Option<NotchGeometry>,
    pub cursor: GeometryPoint,
    pub overlay_open: bool,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ComputerRunRequest {
    pub thread_id: SharedString,
    pub task: SharedString,
    pub max_steps: u32,
}

impl ComputerRunRequest {
    pub fn new(thread_id: impl Into<SharedString>, task: impl Into<SharedString>) -> Self {
        let task = task.into();
        let task: SharedString = task.chars().take(200).collect::<String>().into();
        Self {
            thread_id: thread_id.into(),
            task,
            max_steps: MAX_RUN_STEPS,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HotspotKey {
    pub display_id: u64,
    pub display_y: i32,
    pub notch_x: i32,
    pub notch_width: i32,
    pub notch_height: i32,
}

impl HotspotKey {
    pub fn new(display: NativeDisplay, notch: NotchGeometry) -> Self {
        Self {
            display_id: display.id,
            display_y: display.geometry.bounds.y.round() as i32,
            notch_x: notch.x.round() as i32,
            notch_width: notch.width.round() as i32,
            notch_height: notch.height.round() as i32,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum NativeWindowCommand {
    Open(Box<NativeWindowSpec>),
    Show {
        role: NativeWindowRole,
        inactive: bool,
    },
    Hide {
        role: NativeWindowRole,
    },
    Close {
        role: NativeWindowRole,
    },
    Focus {
        role: NativeWindowRole,
    },
    SetBounds {
        role: NativeWindowRole,
        bounds: SurfaceRect,
    },
    SetIgnoreMouseEvents {
        role: NativeWindowRole,
        ignore: bool,
        forward: bool,
    },
    SetHiddenInMissionControl {
        role: NativeWindowRole,
        hidden: bool,
    },
    MoveAbove {
        role: NativeWindowRole,
        target_window_id: u64,
    },
    UpdateQuickAskSurface {
        surface: OverlaySurface,
        notch: NotchPlacement,
    },
    DispatchQuickAsk(SharedString),
    NewQuickAskSession,
    SendNotchHover(bool),
    SendScreenContext,
    OpenWorkspace(Option<SharedString>),
    ActivateApplication {
        steal: bool,
    },
    RegisterComputerEscape(SharedString),
    UnregisterComputerEscape,
    StopComputerRun(SharedString),
    RequestFrontContext,
    ScheduleHotspotPoll(u64),
    CancelHotspotPoll,
    ScheduleCursorHide(u64),
    CancelCursorHide,
}

impl NativeWindowCommand {
    pub fn requirements(&self) -> Vec<NativeWindowRequirement> {
        match self {
            Self::Open(spec) => spec.requirements(),
            Self::Hide { .. } => vec![NativeWindowRequirement::HideWindow],
            Self::Close { .. } => vec![NativeWindowRequirement::DestroyWindow],
            Self::SetBounds { .. } => vec![NativeWindowRequirement::ProgrammaticBounds],
            Self::SetIgnoreMouseEvents { .. } => {
                vec![NativeWindowRequirement::MousePassthrough]
            }
            Self::SetHiddenInMissionControl { .. } => {
                vec![NativeWindowRequirement::HiddenInMissionControl]
            }
            Self::Show { inactive: true, .. } => vec![NativeWindowRequirement::ShowInactive],
            Self::ActivateApplication { .. } => {
                vec![NativeWindowRequirement::ApplicationActivation]
            }
            Self::RegisterComputerEscape(_) | Self::UnregisterComputerEscape => {
                vec![NativeWindowRequirement::GlobalEscapeShortcut]
            }
            Self::RequestFrontContext => vec![NativeWindowRequirement::FrontmostApplication],
            Self::Focus { .. }
            | Self::Show {
                inactive: false, ..
            }
            | Self::UpdateQuickAskSurface { .. }
            | Self::DispatchQuickAsk(_)
            | Self::NewQuickAskSession
            | Self::SendNotchHover(_)
            | Self::SendScreenContext
            | Self::OpenWorkspace(_)
            | Self::StopComputerRun(_)
            | Self::ScheduleHotspotPoll(_)
            | Self::CancelHotspotPoll
            | Self::ScheduleCursorHide(_)
            | Self::CancelCursorHide => Vec::new(),
            Self::MoveAbove { .. } => vec![NativeWindowRequirement::WindowOrdering],
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct NativeWindowRecord {
    pub role: NativeWindowRole,
    pub phase: NativeWindowPhase,
    pub spec: NativeWindowSpec,
    pub handle: Option<AnyWindowHandle>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeWindowOpenError {
    AlreadyOpen(NativeWindowRole),
    Gpui(SharedString),
}

impl fmt::Display for NativeWindowOpenError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::AlreadyOpen(role) => write!(formatter, "{} is already open", role.id()),
            Self::Gpui(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for NativeWindowOpenError {}

pub struct NativeWindowController {
    platform: NativeHostPlatform,
    reduced_motion: bool,
    overlay_preferences_ready: bool,
    overlay_surface: OverlaySurface,
    overlay_busy: bool,
    capturing: bool,
    annotating: bool,
    close_overlay_when_idle: bool,
    overlay_grow: f32,
    overlay_base_height: f32,
    overlay_display: Option<NativeDisplay>,
    pill_spot: Option<GeometryPoint>,
    queued_overlay_toggle: Option<QuickAskRequest>,
    hotspot_key: Option<HotspotKey>,
    hotspot_hovering: bool,
    annotation_display: Option<u64>,
    annotation_phase: AnnotationWindowPhase,
    computer_cursor_ready: bool,
    computer_runtime_active: bool,
    computer_cursor_at_ms: Option<u64>,
    windows: [Option<NativeWindowRecord>; 7],
}

impl NativeWindowController {
    pub fn new(platform: NativeHostPlatform) -> Self {
        Self {
            platform,
            reduced_motion: false,
            overlay_preferences_ready: true,
            overlay_surface: if platform.is_windows() {
                OverlaySurface::Pill
            } else {
                OverlaySurface::Notch
            },
            overlay_busy: false,
            capturing: false,
            annotating: false,
            close_overlay_when_idle: false,
            overlay_grow: 0.,
            overlay_base_height: 0.,
            overlay_display: None,
            pill_spot: None,
            queued_overlay_toggle: None,
            hotspot_key: None,
            hotspot_hovering: false,
            annotation_display: None,
            annotation_phase: AnnotationWindowPhase::Inactive,
            computer_cursor_ready: false,
            computer_runtime_active: false,
            computer_cursor_at_ms: None,
            windows: std::array::from_fn(|_| None),
        }
    }

    pub fn platform(&self) -> NativeHostPlatform {
        self.platform
    }

    pub fn reduced_motion(&self) -> bool {
        self.reduced_motion
    }

    pub fn set_reduced_motion(&mut self, reduced_motion: bool) {
        self.reduced_motion = reduced_motion;
    }

    pub fn reduced_motion_delay(&self, delay_ms: u64) -> u64 {
        if self.reduced_motion { 0 } else { delay_ms }
    }

    pub fn timer_delay(&self, timer: NativeWindowTimer) -> u64 {
        match timer {
            NativeWindowTimer::HotspotWarm => hotspot_poll_delay(true),
            NativeWindowTimer::HotspotCold => hotspot_poll_delay(false),
            NativeWindowTimer::PillLinger => self.reduced_motion_delay(PILL_LINGER_MS),
            NativeWindowTimer::PillFade => self.reduced_motion_delay(PILL_FADE_MS),
            NativeWindowTimer::AnnotationSettle => self.reduced_motion_delay(ANNOTATION_SETTLE_MS),
            NativeWindowTimer::ComputerCursor => COMPUTER_CURSOR_LIFETIME_MS,
        }
    }

    pub fn record(&self, role: NativeWindowRole) -> Option<&NativeWindowRecord> {
        self.windows[role.index()].as_ref()
    }

    pub fn phase(&self, role: NativeWindowRole) -> NativeWindowPhase {
        self.record(role)
            .map_or(NativeWindowPhase::Closed, |record| record.phase)
    }

    pub fn handle(&self, role: NativeWindowRole) -> Option<AnyWindowHandle> {
        self.record(role).and_then(|record| record.handle)
    }

    pub fn is_present(&self, role: NativeWindowRole) -> bool {
        matches!(
            self.phase(role),
            NativeWindowPhase::Opening
                | NativeWindowPhase::Visible
                | NativeWindowPhase::Hidden
                | NativeWindowPhase::WaitingForIdle
                | NativeWindowPhase::Closing
        )
    }

    pub fn overlay_surface(&self) -> OverlaySurface {
        self.overlay_surface
    }

    pub fn overlay_busy(&self) -> bool {
        self.overlay_busy
    }

    pub fn capturing(&self) -> bool {
        self.capturing
    }

    pub fn annotating(&self) -> bool {
        self.annotating
    }

    pub fn annotation_display(&self) -> Option<u64> {
        self.annotation_display
    }

    pub fn annotation_phase(&self) -> AnnotationWindowPhase {
        self.annotation_phase
    }

    pub fn overlay_growth(&self) -> f32 {
        self.overlay_grow
    }

    pub fn overlay_base_height(&self) -> f32 {
        self.overlay_base_height
    }

    pub fn overlay_display(&self) -> Option<NativeDisplay> {
        self.overlay_display
    }

    pub fn pill_spot(&self) -> Option<GeometryPoint> {
        self.pill_spot
    }

    pub fn hotspot_key(&self) -> Option<HotspotKey> {
        self.hotspot_key
    }

    pub fn hotspot_hovering(&self) -> bool {
        self.hotspot_hovering
    }

    pub fn attach_opened(&mut self, spec: NativeWindowSpec, handle: AnyWindowHandle) -> bool {
        let index = spec.role.index();
        if self.windows[index]
            .as_ref()
            .is_some_and(|record| record.handle.is_some())
        {
            return false;
        }
        let phase = if spec.flags.show {
            NativeWindowPhase::Visible
        } else {
            NativeWindowPhase::Hidden
        };
        self.windows[index] = Some(NativeWindowRecord {
            role: spec.role,
            phase,
            spec,
            handle: Some(handle),
        });
        true
    }

    pub fn request_open(&mut self, spec: NativeWindowSpec) -> Vec<NativeWindowCommand> {
        let index = spec.role.index();
        if self.is_present(spec.role) {
            return Vec::new();
        }
        self.windows[index] = Some(NativeWindowRecord {
            role: spec.role,
            phase: NativeWindowPhase::Opening,
            spec: spec.clone(),
            handle: None,
        });
        let role = spec.role;
        let mut commands = vec![NativeWindowCommand::Open(Box::new(spec))];
        commands.extend(self.post_open_commands(role));
        commands
    }

    pub fn post_open_commands(&self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        let Some(record) = self.record(role) else {
            return Vec::new();
        };
        let mut commands = Vec::new();
        if record.spec.flags.mouse_events_ignored {
            commands.push(NativeWindowCommand::SetIgnoreMouseEvents {
                role,
                ignore: true,
                forward: true,
            });
        }
        if record.spec.flags.hidden_in_mission_control {
            commands.push(NativeWindowCommand::SetHiddenInMissionControl { role, hidden: true });
        }
        commands
    }

    pub fn open_with_root<V>(
        &mut self,
        cx: &mut App,
        spec: NativeWindowSpec,
        build_root: impl FnOnce(&mut Window, &mut App) -> Entity<V>,
    ) -> Result<WindowHandle<V>, NativeWindowOpenError>
    where
        V: 'static + Render,
    {
        let _ = self.reap_closed(cx);
        if self.is_present(spec.role) {
            return Err(NativeWindowOpenError::AlreadyOpen(spec.role));
        }
        let handle = cx
            .open_window(spec.gpui_options(), build_root)
            .map_err(|error| NativeWindowOpenError::Gpui(error.to_string().into()))?;
        self.attach_opened(spec, handle.into());
        Ok(handle)
    }

    pub fn mark_open_failed(&mut self, role: NativeWindowRole) {
        if let Some(record) = self.windows[role.index()].as_mut() {
            record.phase = NativeWindowPhase::Closed;
            record.handle = None;
        }
    }

    pub fn reap_closed(&mut self, cx: &App) -> Vec<NativeWindowCommand> {
        let handles = cx.windows();
        let closed = NativeWindowRole::ALL
            .into_iter()
            .filter(|role| {
                self.handle(*role)
                    .is_some_and(|handle| !handles.contains(&handle))
            })
            .collect::<Vec<_>>();
        closed
            .into_iter()
            .flat_map(|role| self.mark_closed(role))
            .collect()
    }

    pub fn mark_closed(&mut self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        if let Some(record) = self.windows[role.index()].as_mut() {
            record.phase = NativeWindowPhase::Closed;
            record.handle = None;
        }
        match role {
            NativeWindowRole::QuickAsk => {
                self.overlay_busy = false;
                self.capturing = false;
                self.close_overlay_when_idle = false;
                self.overlay_surface = if self.platform.is_windows() {
                    OverlaySurface::Pill
                } else {
                    OverlaySurface::Notch
                };
                self.overlay_grow = 0.;
                self.overlay_base_height = 0.;
                self.overlay_display = None;
                self.close_radial()
            }
            NativeWindowRole::ScreenAnnotation => {
                self.annotating = false;
                self.annotation_display = None;
                self.annotation_phase = AnnotationWindowPhase::Inactive;
                if self.is_present(NativeWindowRole::QuickAsk) {
                    let mut commands = self.show_role(NativeWindowRole::QuickAsk, false);
                    commands.push(NativeWindowCommand::ActivateApplication { steal: true });
                    commands.push(NativeWindowCommand::Focus {
                        role: NativeWindowRole::QuickAsk,
                    });
                    commands.push(NativeWindowCommand::SendScreenContext);
                    commands
                } else {
                    Vec::new()
                }
            }
            NativeWindowRole::NotchHotspot => {
                self.hotspot_hovering = false;
                Vec::new()
            }
            NativeWindowRole::ComputerRunBanner => {
                self.computer_runtime_active = false;
                self.computer_cursor_ready = false;
                self.computer_cursor_at_ms = None;
                Vec::new()
            }
            NativeWindowRole::ComputerActivityCursor => {
                self.computer_cursor_ready = false;
                self.computer_cursor_at_ms = None;
                Vec::new()
            }
            NativeWindowRole::Workspace | NativeWindowRole::RadialCommands => Vec::new(),
        }
    }

    pub fn mark_closed_handle(
        &mut self,
        role: NativeWindowRole,
        handle: AnyWindowHandle,
    ) -> Vec<NativeWindowCommand> {
        if self.handle(role) == Some(handle) {
            self.mark_closed(role)
        } else {
            Vec::new()
        }
    }

    fn show_role(&mut self, role: NativeWindowRole, inactive: bool) -> Vec<NativeWindowCommand> {
        if let Some(record) = self.windows[role.index()].as_mut() {
            record.phase = NativeWindowPhase::Visible;
            record.spec.flags.show = true;
            record.spec.flags.show_inactive = inactive;
            return vec![NativeWindowCommand::Show { role, inactive }];
        }
        Vec::new()
    }

    pub fn reveal_after_load(&mut self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        if role == NativeWindowRole::ComputerActivityCursor {
            return Vec::new();
        }
        let inactive = self
            .record(role)
            .is_some_and(|record| record.spec.flags.show_inactive);
        let mut commands = self.show_role(role, inactive);
        if matches!(
            role,
            NativeWindowRole::QuickAsk | NativeWindowRole::ScreenAnnotation
        ) {
            commands.push(NativeWindowCommand::Focus { role });
        }
        commands
    }

    fn hide_role(&mut self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        if let Some(record) = self.windows[role.index()].as_mut() {
            record.phase = NativeWindowPhase::Hidden;
            return vec![NativeWindowCommand::Hide { role }];
        }
        Vec::new()
    }

    fn request_close(&mut self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        if !self.is_present(role) {
            return Vec::new();
        }
        if let Some(record) = self.windows[role.index()].as_mut() {
            record.phase = NativeWindowPhase::Closing;
        }
        vec![NativeWindowCommand::Close { role }]
    }

    fn retire_close(&mut self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        if !self.is_present(role) {
            return Vec::new();
        }
        if self.phase(role) == NativeWindowPhase::Closing {
            return Vec::new();
        }
        let commands = vec![NativeWindowCommand::Close { role }];
        if let Some(record) = self.windows[role.index()].as_mut() {
            record.phase = NativeWindowPhase::Closing;
        }
        commands
    }

    pub fn ensure_workspace(&mut self, display: NativeDisplay) -> Vec<NativeWindowCommand> {
        if self.is_present(NativeWindowRole::Workspace) {
            let mut commands = self.show_role(NativeWindowRole::Workspace, false);
            commands.push(NativeWindowCommand::Focus {
                role: NativeWindowRole::Workspace,
            });
            commands
        } else {
            self.request_open(NativeWindowSpec::workspace(
                display,
                self.platform,
                self.reduced_motion,
            ))
        }
    }

    pub fn set_overlay_preferences_ready(&mut self, ready: bool) -> Vec<NativeWindowCommand> {
        self.overlay_preferences_ready = ready;
        if ready && let Some(request) = self.queued_overlay_toggle.take() {
            return self.toggle_quick_ask(request);
        }
        Vec::new()
    }

    pub fn toggle_quick_ask(&mut self, request: QuickAskRequest) -> Vec<NativeWindowCommand> {
        if self.annotating {
            return self.cancel_annotation();
        }
        if !self.overlay_preferences_ready {
            self.queued_overlay_toggle = Some(request);
            return Vec::new();
        }
        if self.is_present(NativeWindowRole::QuickAsk) {
            let display = self.overlay_display.unwrap_or(request.display);
            return match self.overlay_surface {
                OverlaySurface::Pill => {
                    let mut commands = Vec::new();
                    if self.overlay_busy && request.concurrency == QuickAskConcurrency::NewSession {
                        commands.push(NativeWindowCommand::NewQuickAskSession);
                    }
                    commands.extend(self.expand_pill(display));
                    commands
                }
                OverlaySurface::Popout => self.collapse_to_pill(display),
                OverlaySurface::Notch => {
                    let hidden =
                        self.phase(NativeWindowRole::QuickAsk) == NativeWindowPhase::Hidden;
                    if hidden && !self.capturing {
                        self.close_overlay_when_idle = false;
                        let mut commands = self.show_role(NativeWindowRole::QuickAsk, true);
                        commands.push(NativeWindowCommand::Focus {
                            role: NativeWindowRole::QuickAsk,
                        });
                        if let Some(command) = request.command {
                            commands.push(NativeWindowCommand::DispatchQuickAsk(command));
                        }
                        commands
                    } else {
                        self.close_overlay()
                    }
                }
            };
        }
        self.overlay_display = Some(request.display);
        self.overlay_busy = false;
        self.close_overlay_when_idle = false;
        self.overlay_surface = if self.platform.is_windows() {
            OverlaySurface::Pill
        } else {
            OverlaySurface::Notch
        };
        self.overlay_grow = 0.;
        if self.overlay_surface == OverlaySurface::Pill {
            let bounds = pill_layout(request.display.geometry, request.pill_spot);
            self.pill_spot = Some(GeometryPoint {
                x: bounds.x,
                y: bounds.y,
            });
        }
        let spec = NativeWindowSpec::quick_ask(
            request.display,
            self.platform,
            self.overlay_surface,
            request.notch_gap,
            request.notch,
            self.pill_spot,
            self.overlay_grow,
            request.command.clone(),
            self.reduced_motion,
        );
        self.overlay_base_height = spec.bounds.height;
        let mut commands = self.request_open(spec);
        if request.command.is_none() {
            commands.push(NativeWindowCommand::RequestFrontContext);
            if request.cursor_orbs_enabled {
                commands.extend(self.open_radial(request.display, request.cursor));
            }
        }
        commands
    }

    pub fn close_overlay(&mut self) -> Vec<NativeWindowCommand> {
        if self.annotating {
            return self.hide_role(NativeWindowRole::QuickAsk);
        }
        if self.overlay_busy {
            self.close_overlay_when_idle = true;
            let commands = self.hide_role(NativeWindowRole::QuickAsk);
            if let Some(record) = self.windows[NativeWindowRole::QuickAsk.index()].as_mut() {
                record.phase = NativeWindowPhase::WaitingForIdle;
            }
            return commands;
        }
        self.close_overlay_when_idle = false;
        self.request_close(NativeWindowRole::QuickAsk)
    }

    pub fn finish_overlay_work(&mut self) -> Vec<NativeWindowCommand> {
        self.overlay_busy = false;
        if self.close_overlay_when_idle {
            self.close_overlay()
        } else {
            Vec::new()
        }
    }

    pub fn set_overlay_busy(&mut self, busy: bool) -> Vec<NativeWindowCommand> {
        self.overlay_busy = busy;
        if !busy && self.close_overlay_when_idle {
            return self.close_overlay();
        }
        Vec::new()
    }

    pub fn set_capturing(&mut self, capturing: bool) {
        self.capturing = capturing;
    }

    pub fn leave_overlay(&mut self, display: NativeDisplay) -> Vec<NativeWindowCommand> {
        if self.overlay_surface == OverlaySurface::Notch && !self.overlay_busy {
            self.close_overlay()
        } else {
            self.collapse_to_pill(display)
        }
    }

    pub fn collapse_to_pill(&mut self, display: NativeDisplay) -> Vec<NativeWindowCommand> {
        let index = NativeWindowRole::QuickAsk.index();
        if self.windows[index].is_none() {
            return Vec::new();
        }
        let bounds = pill_layout(display.geometry, self.pill_spot);
        self.pill_spot = Some(GeometryPoint {
            x: bounds.x,
            y: bounds.y,
        });
        self.overlay_surface = OverlaySurface::Pill;
        self.overlay_display = Some(display);
        let notch = NotchPlacement {
            left: 0.,
            width: 0.,
            height: 0.,
        };
        if let Some(record) = self.windows[index].as_mut() {
            record.spec.bounds = bounds;
            record.spec.display_id = Some(display.id);
            record.spec.overlay_surface = Some(OverlaySurface::Pill);
            record.spec.notch = Some(notch);
        }
        let mut commands = vec![NativeWindowCommand::SetBounds {
            role: NativeWindowRole::QuickAsk,
            bounds,
        }];
        commands.push(NativeWindowCommand::UpdateQuickAskSurface {
            surface: OverlaySurface::Pill,
            notch,
        });
        commands.extend(self.close_radial());
        commands
    }

    pub fn expand_pill(&mut self, display: NativeDisplay) -> Vec<NativeWindowCommand> {
        let index = NativeWindowRole::QuickAsk.index();
        let Some(record) = self.windows[index].as_ref() else {
            return Vec::new();
        };
        let pill = GeometryPoint {
            x: record.spec.bounds.x,
            y: record.spec.bounds.y,
        };
        let layout = popout_layout(display.geometry, pill, self.overlay_grow);
        self.overlay_surface = OverlaySurface::Popout;
        self.overlay_display = Some(display);
        self.overlay_base_height = layout.base;
        let notch = NotchPlacement {
            left: 0.,
            width: 0.,
            height: 0.,
        };
        if let Some(record) = self.windows[index].as_mut() {
            record.spec.bounds = layout.bounds;
            record.spec.display_id = Some(display.id);
            record.spec.overlay_surface = Some(OverlaySurface::Popout);
            record.spec.notch = Some(notch);
        }
        vec![
            NativeWindowCommand::SetBounds {
                role: NativeWindowRole::QuickAsk,
                bounds: layout.bounds,
            },
            NativeWindowCommand::UpdateQuickAskSurface {
                surface: OverlaySurface::Popout,
                notch,
            },
            NativeWindowCommand::Focus {
                role: NativeWindowRole::QuickAsk,
            },
        ]
    }

    pub fn set_overlay_growth(&mut self, grow: f32) -> Vec<NativeWindowCommand> {
        let next = overlay_growth(grow);
        self.overlay_grow = next;
        if self.overlay_surface == OverlaySurface::Pill {
            return Vec::new();
        }
        let index = NativeWindowRole::QuickAsk.index();
        if self.windows[index].is_none() {
            return Vec::new();
        }
        let height = self.overlay_base_height + next;
        let current_height = self.windows[index]
            .as_ref()
            .map_or(height, |record| record.spec.bounds.height);
        if (current_height - height).abs() < f32::EPSILON {
            return Vec::new();
        }
        let bounds = if let Some(record) = self.windows[index].as_mut() {
            record.spec.bounds.height = height;
            record.spec.bounds
        } else {
            return Vec::new();
        };
        vec![NativeWindowCommand::SetBounds {
            role: NativeWindowRole::QuickAsk,
            bounds,
        }]
    }

    pub fn move_pill(
        &mut self,
        display: NativeDisplay,
        point: GeometryPoint,
    ) -> Vec<NativeWindowCommand> {
        if self.overlay_surface != OverlaySurface::Pill {
            return Vec::new();
        }
        let spot = GeometryPoint {
            x: point.x.round(),
            y: point.y.round(),
        };
        let bounds = pill_layout(display.geometry, Some(spot));
        self.pill_spot = Some(GeometryPoint {
            x: bounds.x,
            y: bounds.y,
        });
        self.overlay_display = Some(display);
        let index = NativeWindowRole::QuickAsk.index();
        if self.windows[index].is_none() {
            return Vec::new();
        }
        if let Some(record) = self.windows[index].as_mut() {
            record.spec.bounds = bounds;
            record.spec.display_id = Some(display.id);
        }
        vec![NativeWindowCommand::SetBounds {
            role: NativeWindowRole::QuickAsk,
            bounds,
        }]
    }

    pub fn open_workspace_from_overlay(
        &mut self,
        display: NativeDisplay,
        settings_page: Option<SharedString>,
    ) -> Vec<NativeWindowCommand> {
        let mut commands = self.close_overlay();
        commands.push(NativeWindowCommand::OpenWorkspace(settings_page));
        commands.extend(self.ensure_workspace(display));
        commands
    }

    fn close_radial(&mut self) -> Vec<NativeWindowCommand> {
        self.retire_close(NativeWindowRole::RadialCommands)
    }

    pub fn open_radial(
        &mut self,
        display: NativeDisplay,
        cursor: GeometryPoint,
    ) -> Vec<NativeWindowCommand> {
        if self.is_present(NativeWindowRole::RadialCommands) {
            return Vec::new();
        }
        self.request_open(NativeWindowSpec::radial_commands(
            display,
            cursor,
            self.platform,
            self.reduced_motion,
        ))
    }

    pub fn close_hotspot(&mut self) -> Vec<NativeWindowCommand> {
        self.hotspot_hovering = false;
        self.retire_close(NativeWindowRole::NotchHotspot)
    }

    pub fn poll_hotspot(&mut self, request: HotspotPollRequest) -> Vec<NativeWindowCommand> {
        let Some(notch) = request.notch else {
            self.hotspot_hovering = false;
            let mut commands = self.close_hotspot();
            commands.push(NativeWindowCommand::CancelHotspotPoll);
            return commands;
        };
        let key = HotspotKey::new(request.display, notch);
        let mut commands = Vec::new();
        if self.hotspot_key != Some(key) {
            self.hotspot_key = Some(key);
            commands.extend(self.close_hotspot());
        }
        let layout = hotspot_layout(request.display.geometry, notch);
        let warm =
            !request.overlay_open && near_bounds(layout.bounds, request.cursor, HOTSPOT_WARM);
        if !warm {
            self.hotspot_hovering = false;
            commands.extend(self.close_hotspot());
        } else {
            if !self.is_present(NativeWindowRole::NotchHotspot) {
                commands.extend(self.request_open(NativeWindowSpec::notch_hotspot(
                    request.display,
                    notch,
                    self.platform,
                    self.reduced_motion,
                )));
            }
            let inside = near_bounds(layout.hot, request.cursor, 0.);
            if inside != self.hotspot_hovering {
                self.hotspot_hovering = inside;
                commands.push(NativeWindowCommand::SetIgnoreMouseEvents {
                    role: NativeWindowRole::NotchHotspot,
                    ignore: !inside,
                    forward: true,
                });
                commands.push(NativeWindowCommand::SendNotchHover(inside));
            }
        }
        commands.push(NativeWindowCommand::ScheduleHotspotPoll(
            hotspot_poll_delay(warm),
        ));
        commands
    }

    pub fn start_annotation(&mut self, display: NativeDisplay) -> Vec<NativeWindowCommand> {
        if !self.is_present(NativeWindowRole::QuickAsk) || self.annotating {
            return Vec::new();
        }
        self.annotating = true;
        self.annotation_display = Some(display.id);
        self.annotation_phase = AnnotationWindowPhase::Capturing;
        let mut commands = self.hide_role(NativeWindowRole::QuickAsk);
        commands.extend(self.request_open(NativeWindowSpec::screen_annotation(
            display,
            self.platform,
            self.reduced_motion,
        )));
        commands
    }

    pub fn set_annotation_phase(&mut self, phase: AnnotationWindowPhase) {
        self.annotation_phase = phase;
    }

    pub fn finish_annotation(&mut self) -> Vec<NativeWindowCommand> {
        self.annotating = false;
        self.annotation_display = None;
        self.annotation_phase = AnnotationWindowPhase::Inactive;
        let mut commands = self.request_close(NativeWindowRole::ScreenAnnotation);
        if self.is_present(NativeWindowRole::QuickAsk) {
            commands.extend(self.show_role(NativeWindowRole::QuickAsk, false));
            commands.push(NativeWindowCommand::ActivateApplication { steal: true });
            commands.push(NativeWindowCommand::Focus {
                role: NativeWindowRole::QuickAsk,
            });
            commands.push(NativeWindowCommand::SendScreenContext);
        }
        commands
    }

    pub fn cancel_annotation(&mut self) -> Vec<NativeWindowCommand> {
        self.finish_annotation()
    }

    pub fn open_run_banner(
        &mut self,
        display: NativeDisplay,
        request: ComputerRunRequest,
    ) -> Vec<NativeWindowCommand> {
        let mut commands = self.close_run_banner();
        self.computer_runtime_active = true;
        self.computer_cursor_ready = false;
        self.computer_cursor_at_ms = None;
        commands.push(NativeWindowCommand::RegisterComputerEscape(
            request.thread_id.clone(),
        ));
        commands.extend(self.request_open(NativeWindowSpec::computer_run_banner(
            display,
            self.platform,
            &request,
            self.reduced_motion,
        )));
        commands.extend(
            self.request_open(NativeWindowSpec::computer_activity_cursor(
                self.platform,
                self.reduced_motion,
            )),
        );
        commands
    }

    pub fn close_run_banner(&mut self) -> Vec<NativeWindowCommand> {
        self.computer_runtime_active = false;
        self.computer_cursor_ready = false;
        self.computer_cursor_at_ms = None;
        let mut commands = vec![NativeWindowCommand::UnregisterComputerEscape];
        commands.push(NativeWindowCommand::CancelCursorHide);
        commands.extend(self.retire_close(NativeWindowRole::ComputerActivityCursor));
        commands.extend(self.retire_close(NativeWindowRole::ComputerRunBanner));
        commands
    }

    pub fn set_computer_cursor_ready(&mut self, ready: bool) {
        self.computer_cursor_ready = ready;
    }

    pub fn set_computer_runtime_active(&mut self, active: bool) {
        self.computer_runtime_active = active;
    }

    pub fn update_computer_progress(
        &mut self,
        progress: &ComputerProgress,
        now_ms: u64,
    ) -> Vec<NativeWindowCommand> {
        if progress.cursor.is_none() {
            return Vec::new();
        }
        self.computer_cursor_at_ms = Some(now_ms);
        let Some(cursor) = progress.cursor.as_ref().and_then(|cursor| cursor.rounded()) else {
            return self.hide_computer_cursor();
        };
        if !self.computer_runtime_active
            || !self.computer_cursor_ready
            || !self.is_present(NativeWindowRole::ComputerActivityCursor)
        {
            return self.hide_computer_cursor();
        }
        let mut commands = vec![NativeWindowCommand::CancelCursorHide];
        if let Some(record) =
            self.windows[NativeWindowRole::ComputerActivityCursor.index()].as_mut()
        {
            record.spec.bounds = cursor.bounds;
            record.phase = NativeWindowPhase::Visible;
        }
        commands.push(NativeWindowCommand::SetBounds {
            role: NativeWindowRole::ComputerActivityCursor,
            bounds: cursor.bounds,
        });
        commands.push(NativeWindowCommand::Show {
            role: NativeWindowRole::ComputerActivityCursor,
            inactive: true,
        });
        commands.push(NativeWindowCommand::MoveAbove {
            role: NativeWindowRole::ComputerActivityCursor,
            target_window_id: cursor.window_id,
        });
        commands.push(NativeWindowCommand::ScheduleCursorHide(
            self.timer_delay(NativeWindowTimer::ComputerCursor),
        ));
        commands
    }

    pub fn hide_computer_cursor(&mut self) -> Vec<NativeWindowCommand> {
        self.computer_cursor_at_ms = None;
        let mut commands = vec![NativeWindowCommand::CancelCursorHide];
        commands.extend(self.hide_role(NativeWindowRole::ComputerActivityCursor));
        commands
    }

    pub fn handle_escape(&mut self, role: NativeWindowRole) -> Vec<NativeWindowCommand> {
        match role {
            NativeWindowRole::QuickAsk => self.leave_overlay_for_escape(),
            NativeWindowRole::ScreenAnnotation => self.cancel_annotation(),
            NativeWindowRole::ComputerRunBanner => {
                let thread_id = self
                    .record(NativeWindowRole::ComputerRunBanner)
                    .and_then(|record| record.spec.thread_id.clone());
                thread_id.map_or_else(Vec::new, |thread_id| {
                    vec![NativeWindowCommand::StopComputerRun(thread_id)]
                })
            }
            NativeWindowRole::NotchHotspot => self.close_hotspot(),
            NativeWindowRole::RadialCommands => self.close_radial(),
            NativeWindowRole::Workspace | NativeWindowRole::ComputerActivityCursor => Vec::new(),
        }
    }

    fn leave_overlay_for_escape(&mut self) -> Vec<NativeWindowCommand> {
        if self.overlay_surface == OverlaySurface::Notch && !self.overlay_busy {
            self.close_overlay()
        } else {
            self.collapse_to_pill_from_record()
        }
    }

    fn collapse_to_pill_from_record(&mut self) -> Vec<NativeWindowCommand> {
        let Some(record) = self.record(NativeWindowRole::QuickAsk) else {
            return Vec::new();
        };
        let display = NativeDisplay {
            id: record.spec.display_id.unwrap_or_default(),
            geometry: DisplayGeometry {
                bounds: record.spec.bounds,
                work_area: record.spec.bounds,
            },
        };
        let display = self.overlay_display.unwrap_or(display);
        self.collapse_to_pill(display)
    }
}

impl Default for NativeWindowController {
    fn default() -> Self {
        Self::new(NativeHostPlatform::Other)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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

    fn quick_request() -> QuickAskRequest {
        QuickAskRequest {
            display: display(),
            notch_gap: 180.,
            notch: Some(notch()),
            pill_spot: None,
            cursor: GeometryPoint { x: 640., y: 420. },
            cursor_orbs_enabled: false,
            concurrency: QuickAskConcurrency::Continue,
            command: None,
        }
    }

    #[test]
    fn workspace_spec_matches_electron_geometry_and_constraints() {
        let spec = NativeWindowSpec::workspace(display(), NativeHostPlatform::MacOS, false);
        assert_eq!(
            spec.bounds,
            SurfaceRect::new(0., 0., WORKSPACE_WIDTH, WORKSPACE_HEIGHT)
        );
        assert_eq!(
            spec.min_size,
            Some(NativeSize::new(WORKSPACE_MIN_WIDTH, WORKSPACE_MIN_HEIGHT))
        );
        assert!(spec.flags.decorated);
        assert!(spec.flags.transparent);
        assert!(spec.titlebar_transparent);
    }

    #[test]
    fn overlay_specs_keep_exact_surface_bounds() {
        let notch_spec = NativeWindowSpec::quick_ask(
            display(),
            NativeHostPlatform::MacOS,
            OverlaySurface::Notch,
            180.,
            Some(notch()),
            None,
            0.,
            None,
            false,
        );
        assert_eq!(notch_spec.bounds, SurfaceRect::new(380., 0., 620., 255.));
        let pill = pill_layout(display().geometry, None);
        let popout_spec = NativeWindowSpec::quick_ask(
            display(),
            NativeHostPlatform::Windows,
            OverlaySurface::Popout,
            180.,
            None,
            Some(GeometryPoint {
                x: pill.x,
                y: pill.y,
            }),
            0.,
            None,
            false,
        );
        assert_eq!(popout_spec.bounds, SurfaceRect::new(760., 40., 620., 125.));
        assert_eq!(
            NativeWindowSpec::notch_hotspot(display(), notch(), NativeHostPlatform::MacOS, false)
                .bounds,
            SurfaceRect::new(586., 0., 208., 76.)
        );
        assert_eq!(
            NativeWindowSpec::radial_commands(
                display(),
                GeometryPoint { x: 1379., y: 859. },
                NativeHostPlatform::MacOS,
                false
            )
            .bounds,
            SurfaceRect::new(1120., 600., 260., 260.)
        );
    }

    #[test]
    fn display_selection_uses_nearest_screen_geometry() {
        let secondary = NativeDisplay::new(
            8,
            DisplayGeometry {
                bounds: SurfaceRect::new(1380., 0., 1200., 900.),
                work_area: SurfaceRect::new(1380., 24., 1200., 876.),
            },
        );
        assert_eq!(
            display_nearest(&[display(), secondary], GeometryPoint { x: 1500., y: 400. })
                .map(|display| display.id),
            Some(8)
        );
        assert_eq!(
            display_nearest(&[display(), secondary], GeometryPoint { x: 100., y: 100. })
                .map(|display| display.id),
            Some(7)
        );
        assert!(display_nearest(&[], GeometryPoint { x: 0., y: 0. }).is_none());
    }

    #[test]
    fn gpui_options_encode_initial_window_capabilities() {
        let workspace = NativeWindowSpec::workspace(display(), NativeHostPlatform::MacOS, false);
        let options = workspace.gpui_options();
        assert_eq!(options.display_id, Some(DisplayId::from(7)));
        assert!(matches!(options.kind, WindowKind::Normal));
        assert!(matches!(
            options.window_background,
            WindowBackgroundAppearance::Transparent
        ));
        let overlay = NativeWindowSpec::radial_commands(
            display(),
            GeometryPoint { x: 640., y: 420. },
            NativeHostPlatform::MacOS,
            false,
        );
        let options = overlay.gpui_options();
        assert!(!options.focus);
        assert!(!options.is_resizable);
        assert!(matches!(options.kind, WindowKind::PopUp));
        assert!(matches!(
            options.window_background,
            WindowBackgroundAppearance::Transparent
        ));
    }

    #[test]
    fn loaded_surface_reveal_matches_electron_focus_rules() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        controller.request_open(NativeWindowSpec::quick_ask(
            display(),
            NativeHostPlatform::MacOS,
            OverlaySurface::Notch,
            180.,
            Some(notch()),
            None,
            0.,
            None,
            false,
        ));
        let commands = controller.reveal_after_load(NativeWindowRole::QuickAsk);
        assert!(matches!(
            commands.as_slice(),
            [
                NativeWindowCommand::Show {
                    role: NativeWindowRole::QuickAsk,
                    inactive: true
                },
                NativeWindowCommand::Focus {
                    role: NativeWindowRole::QuickAsk
                }
            ]
        ));
        controller.request_open(NativeWindowSpec::computer_activity_cursor(
            NativeHostPlatform::MacOS,
            false,
        ));
        assert!(
            controller
                .reveal_after_load(NativeWindowRole::ComputerActivityCursor)
                .is_empty()
        );
        assert_eq!(
            controller.phase(NativeWindowRole::ComputerActivityCursor),
            NativeWindowPhase::Opening
        );
    }

    #[test]
    fn queued_toggle_reopens_after_preferences_are_ready() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        controller.set_overlay_preferences_ready(false);
        assert!(controller.toggle_quick_ask(quick_request()).is_empty());
        assert_eq!(
            controller.phase(NativeWindowRole::QuickAsk),
            NativeWindowPhase::Closed
        );
        let commands = controller.set_overlay_preferences_ready(true);
        assert!(matches!(
            commands.first(),
            Some(NativeWindowCommand::Open(_))
        ));
        assert_eq!(
            controller.phase(NativeWindowRole::QuickAsk),
            NativeWindowPhase::Opening
        );
    }

    #[test]
    fn native_close_waits_for_the_platform_closed_event() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        controller.request_open(NativeWindowSpec::radial_commands(
            display(),
            GeometryPoint { x: 640., y: 420. },
            NativeHostPlatform::MacOS,
            false,
        ));
        let commands = controller.close_radial();
        assert!(matches!(
            commands.as_slice(),
            [NativeWindowCommand::Close {
                role: NativeWindowRole::RadialCommands
            }]
        ));
        assert_eq!(
            controller.phase(NativeWindowRole::RadialCommands),
            NativeWindowPhase::Closing
        );
        assert!(controller.close_radial().is_empty());
        controller.mark_closed(NativeWindowRole::RadialCommands);
        assert_eq!(
            controller.phase(NativeWindowRole::RadialCommands),
            NativeWindowPhase::Closed
        );
    }

    #[test]
    fn quick_ask_transitions_match_pill_popout_and_idle_close_rules() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::Windows);
        let commands = controller.toggle_quick_ask(quick_request());
        assert!(matches!(
            commands.first(),
            Some(NativeWindowCommand::Open(_))
        ));
        assert!(
            controller
                .toggle_quick_ask(quick_request())
                .iter()
                .any(|command| matches!(
                    command,
                    NativeWindowCommand::UpdateQuickAskSurface {
                        surface: OverlaySurface::Popout,
                        ..
                    }
                ))
        );
        controller.set_overlay_busy(true);
        let commands = controller.close_overlay();
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, NativeWindowCommand::Hide { .. }))
        );
        assert_eq!(
            controller.phase(NativeWindowRole::QuickAsk),
            NativeWindowPhase::WaitingForIdle
        );
        assert!(
            controller
                .finish_overlay_work()
                .iter()
                .any(|command| matches!(
                    command,
                    NativeWindowCommand::Close {
                        role: NativeWindowRole::QuickAsk
                    }
                ))
        );
    }

    #[test]
    fn hotspot_poll_uses_exact_warm_delay_and_mouse_passthrough() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        let commands = controller.poll_hotspot(HotspotPollRequest {
            display: display(),
            notch: Some(notch()),
            cursor: GeometryPoint { x: 600., y: 0. },
            overlay_open: false,
        });
        assert!(commands.iter().any(|command| matches!(
            command,
            NativeWindowCommand::SetIgnoreMouseEvents {
                ignore: false,
                forward: true,
                ..
            }
        )));
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, NativeWindowCommand::ScheduleHotspotPoll(120)))
        );
        let commands = controller.poll_hotspot(HotspotPollRequest {
            display: display(),
            notch: Some(notch()),
            cursor: GeometryPoint { x: 0., y: 500. },
            overlay_open: false,
        });
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, NativeWindowCommand::ScheduleHotspotPoll(250)))
        );
    }

    #[test]
    fn annotation_escape_restores_quick_ask_and_screen_context() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        controller.toggle_quick_ask(quick_request());
        let commands = controller.start_annotation(display());
        assert!(commands.iter().any(|command| matches!(
            command,
            NativeWindowCommand::Open(spec)
                if spec.role == NativeWindowRole::ScreenAnnotation
        )));
        let commands = controller.handle_escape(NativeWindowRole::ScreenAnnotation);
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, NativeWindowCommand::SendScreenContext))
        );
        assert!(!controller.annotating());
    }

    #[test]
    fn computer_cursor_lifetime_and_escape_route_are_typed() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        let request = ComputerRunRequest::new("thread-1", "background app control");
        let commands = controller.open_run_banner(display(), request.clone());
        assert!(commands.iter().any(|command| matches!(
            command,
            NativeWindowCommand::RegisterComputerEscape(id) if id == "thread-1"
        )));
        controller.set_computer_cursor_ready(true);
        let progress = ComputerProgress {
            cursor: Some(crate::overlay_surfaces::ComputerCursor {
                window_id: 12,
                bounds: SurfaceRect::new(10., 20., 40., 30.),
                x: 20.,
                y: 30.,
            }),
            ..Default::default()
        };
        let commands = controller.update_computer_progress(&progress, 1000);
        assert!(
            commands
                .iter()
                .any(|command| matches!(command, NativeWindowCommand::ScheduleCursorHide(1400)))
        );
        let commands = controller.handle_escape(NativeWindowRole::ComputerRunBanner);
        assert!(commands.iter().any(|command| matches!(
            command,
            NativeWindowCommand::StopComputerRun(id) if id == "thread-1"
        )));
    }

    #[test]
    fn native_requirements_identify_unavailable_window_manager_controls() {
        let spec = NativeWindowSpec::computer_activity_cursor(NativeHostPlatform::MacOS, false);
        let requirements = spec.requirements();
        assert!(requirements.contains(&NativeWindowRequirement::MousePassthrough));
        assert!(requirements.contains(&NativeWindowRequirement::HiddenInMissionControl));
        assert!(requirements.contains(&NativeWindowRequirement::SkipTaskbar));
        assert!(requirements.contains(&NativeWindowRequirement::NativeDecorations));
        let hotspot =
            NativeWindowSpec::notch_hotspot(display(), notch(), NativeHostPlatform::MacOS, false);
        assert!(
            hotspot
                .requirements()
                .contains(&NativeWindowRequirement::DisplayAndNotchGeometry)
        );
    }

    #[test]
    fn escape_collapse_keeps_the_overlay_display_work_area() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::Windows);
        controller.toggle_quick_ask(quick_request());
        controller.toggle_quick_ask(quick_request());
        let other = NativeDisplay::new(
            8,
            DisplayGeometry {
                bounds: SurfaceRect::new(1380., 0., 1200., 900.),
                work_area: SurfaceRect::new(1380., 24., 1200., 876.),
            },
        );
        let mut other_request = quick_request();
        other_request.display = other;
        controller.toggle_quick_ask(other_request);
        let commands = controller.handle_escape(NativeWindowRole::QuickAsk);
        let expected = pill_layout(display().geometry, None);
        assert!(commands.iter().any(|command| matches!(
            command,
            NativeWindowCommand::SetBounds { bounds, .. } if *bounds == expected
        )));
        assert_eq!(controller.overlay_display(), Some(display()));
    }

    #[test]
    fn reduced_motion_only_removes_visual_delays() {
        let mut controller = NativeWindowController::new(NativeHostPlatform::MacOS);
        assert_eq!(controller.timer_delay(NativeWindowTimer::PillLinger), 2400);
        assert_eq!(controller.timer_delay(NativeWindowTimer::PillFade), 320);
        assert_eq!(
            controller.timer_delay(NativeWindowTimer::AnnotationSettle),
            700
        );
        assert_eq!(
            controller.timer_delay(NativeWindowTimer::ComputerCursor),
            1400
        );
        controller.set_reduced_motion(true);
        assert_eq!(controller.timer_delay(NativeWindowTimer::PillLinger), 0);
        assert_eq!(controller.timer_delay(NativeWindowTimer::PillFade), 0);
        assert_eq!(
            controller.timer_delay(NativeWindowTimer::AnnotationSettle),
            0
        );
        assert_eq!(
            controller.timer_delay(NativeWindowTimer::ComputerCursor),
            1400
        );
        assert_eq!(controller.timer_delay(NativeWindowTimer::HotspotWarm), 120);
    }
}
