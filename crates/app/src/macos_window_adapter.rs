use std::{fmt, time::Duration};

use gpui::{App, AsyncApp, Task};

use crate::{
    native_windows::{
        NativeDisplay, NativeHostPlatform, NativeWindowCommand, NativeWindowController,
        NativeWindowRequirement, NativeWindowRole, NativeWindowTimer,
    },
    overlay_surfaces::{GeometryError, GeometryPoint, NotchGeometry, parse_notch_geometry},
};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeWindowCommandDisposition {
    Native,
    RootOwned(NativeWindowRole),
    ApplicationOwned,
    TimerOwned(NativeWindowTimer),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMaterial {
    SidebarActive,
    Opaque,
}

impl WorkspaceMaterial {
    pub const fn is_translucent(self) -> bool {
        matches!(self, Self::SidebarActive)
    }
}

pub const fn workspace_material_for(reduce_transparency: bool) -> WorkspaceMaterial {
    if reduce_transparency {
        WorkspaceMaterial::Opaque
    } else {
        WorkspaceMaterial::SidebarActive
    }
}

impl NativeWindowCommandDisposition {
    pub const fn for_command(command: &NativeWindowCommand) -> Self {
        match command {
            NativeWindowCommand::Open(spec) => Self::RootOwned(spec.role),
            NativeWindowCommand::Show { .. }
            | NativeWindowCommand::Hide { .. }
            | NativeWindowCommand::Close { .. }
            | NativeWindowCommand::Focus { .. }
            | NativeWindowCommand::SetBounds { .. }
            | NativeWindowCommand::SetIgnoreMouseEvents { .. }
            | NativeWindowCommand::SetHiddenInMissionControl { .. }
            | NativeWindowCommand::MoveAbove { .. }
            | NativeWindowCommand::ActivateApplication { .. } => Self::Native,
            NativeWindowCommand::ScheduleHotspotPoll(_) => {
                Self::TimerOwned(NativeWindowTimer::HotspotCold)
            }
            NativeWindowCommand::CancelHotspotPoll => {
                Self::TimerOwned(NativeWindowTimer::HotspotCold)
            }
            NativeWindowCommand::ScheduleCursorHide(_) => {
                Self::TimerOwned(NativeWindowTimer::ComputerCursor)
            }
            NativeWindowCommand::CancelCursorHide => {
                Self::TimerOwned(NativeWindowTimer::ComputerCursor)
            }
            NativeWindowCommand::UpdateQuickAskSurface { .. }
            | NativeWindowCommand::DispatchQuickAsk(_)
            | NativeWindowCommand::NewQuickAskSession
            | NativeWindowCommand::SendNotchHover(_)
            | NativeWindowCommand::SendScreenContext
            | NativeWindowCommand::OpenWorkspace(_)
            | NativeWindowCommand::RegisterComputerEscape(_)
            | NativeWindowCommand::UnregisterComputerEscape
            | NativeWindowCommand::StopComputerRun(_)
            | NativeWindowCommand::RequestFrontContext => Self::ApplicationOwned,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NativeWindowAdapterError {
    UnsupportedPlatform(NativeHostPlatform),
    MissingWindow(NativeWindowRole),
    Gpui(SharedError),
    Native(&'static str),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SharedError(String);

impl From<String> for SharedError {
    fn from(value: String) -> Self {
        Self(value)
    }
}

impl From<&str> for SharedError {
    fn from(value: &str) -> Self {
        Self(value.to_owned())
    }
}

impl fmt::Display for NativeWindowAdapterError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::UnsupportedPlatform(platform) => {
                write!(
                    formatter,
                    "native window operations are unavailable for {platform:?}"
                )
            }
            Self::MissingWindow(role) => write!(formatter, "{} has no live GPUI window", role.id()),
            Self::Gpui(error) => formatter.write_str(&error.0),
            Self::Native(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for NativeWindowAdapterError {}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NativeWindowAdapter {
    platform: NativeHostPlatform,
}

impl NativeWindowAdapter {
    pub const fn new(platform: NativeHostPlatform) -> Self {
        Self { platform }
    }

    pub const fn platform(self) -> NativeHostPlatform {
        self.platform
    }

    pub const fn command_disposition(
        command: &NativeWindowCommand,
    ) -> NativeWindowCommandDisposition {
        NativeWindowCommandDisposition::for_command(command)
    }

    pub fn apply(
        &self,
        command: &NativeWindowCommand,
        controller: &NativeWindowController,
        cx: &mut App,
    ) -> Result<NativeWindowCommandDisposition, NativeWindowAdapterError> {
        let disposition = Self::command_disposition(command);
        if disposition != NativeWindowCommandDisposition::Native {
            return Ok(disposition);
        }
        if !self.platform.is_macos() {
            return Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform));
        }
        #[cfg(target_os = "macos")]
        {
            macos::apply(command, controller, cx)?;
            Ok(disposition)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (command, controller, cx);
            Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform))
        }
    }

    pub fn configure(
        &self,
        role: NativeWindowRole,
        controller: &NativeWindowController,
        cx: &mut App,
    ) -> Result<(), NativeWindowAdapterError> {
        if !self.platform.is_macos() {
            return Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform));
        }
        let Some(record) = controller.record(role) else {
            return Err(NativeWindowAdapterError::MissingWindow(role));
        };
        let Some(handle) = record.handle else {
            return Err(NativeWindowAdapterError::MissingWindow(role));
        };
        #[cfg(target_os = "macos")]
        {
            macos::configure(handle, &record.spec, cx)
        }
        #[cfg(not(target_os = "macos"))]
        {
            let _ = (handle, cx);
            Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform))
        }
    }

    pub fn schedule_timer(
        &self,
        cx: &App,
        delay_ms: u64,
        callback: impl FnOnce(&mut AsyncApp) + 'static,
    ) -> Task<()> {
        cx.spawn(async move |cx| {
            cx.background_executor()
                .timer(Duration::from_millis(delay_ms))
                .await;
            callback(cx);
        })
    }

    pub fn displays(&self, cx: &App) -> Vec<NativeDisplay> {
        #[cfg(target_os = "macos")]
        {
            let displays = macos::display_snapshots()
                .into_iter()
                .map(|snapshot| snapshot.display)
                .collect::<Vec<_>>();
            if !displays.is_empty() {
                return displays;
            }
        }
        cx.displays()
            .into_iter()
            .map(|display| crate::native_windows::display_from_platform(display.as_ref()))
            .collect()
    }

    pub fn primary_display(&self, cx: &App) -> Option<NativeDisplay> {
        #[cfg(target_os = "macos")]
        if let Some(id) = macos::primary_display_id()
            && let Some(display) = self
                .displays(cx)
                .into_iter()
                .find(|display| display.id == id)
        {
            return Some(display);
        }
        self.displays(cx).into_iter().next()
    }

    pub fn cursor_screen_point(
        &self,
    ) -> Result<(NativeDisplay, GeometryPoint), NativeWindowAdapterError> {
        if !self.platform.is_macos() {
            return Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform));
        }
        #[cfg(target_os = "macos")]
        {
            macos::cursor_screen_point()
        }
        #[cfg(not(target_os = "macos"))]
        Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform))
    }

    pub fn frontmost_application(&self) -> Result<Option<String>, NativeWindowAdapterError> {
        if !self.platform.is_macos() {
            return Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform));
        }
        #[cfg(target_os = "macos")]
        {
            Ok(macos::frontmost_application())
        }
        #[cfg(not(target_os = "macos"))]
        Err(NativeWindowAdapterError::UnsupportedPlatform(self.platform))
    }

    pub fn parse_notch_line(&self, line: &str) -> Result<Vec<NotchGeometry>, GeometryError> {
        parse_notch_geometry(line)
    }

    pub fn requirements_for(&self, command: &NativeWindowCommand) -> Vec<NativeWindowRequirement> {
        command.requirements()
    }
}

#[cfg(target_os = "macos")]
mod macos {
    use std::{
        ffi::{CStr, c_char, c_void},
        mem::transmute,
        ptr,
    };

    use gpui::{AnyWindowHandle, App, Window};
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    use crate::{
        native_windows::{
            NativeDisplay, NativeWindowCommand, NativeWindowController, NativeWindowRole,
            NativeWindowSpec,
        },
        overlay_surfaces::{DisplayGeometry, GeometryPoint, SurfaceRect},
    };

    use super::{NativeWindowAdapterError, SharedError};

    type Id = *mut c_void;
    type Sel = *const c_void;
    type ObjcBool = i8;
    type ObjcInteger = i64;
    type ObjcUnsigned = u64;

    const YES: ObjcBool = 1;
    const NO: ObjcBool = 0;
    const NS_WINDOW_ABOVE: ObjcInteger = 1;
    const NS_WINDOW_BELOW: ObjcInteger = -1;
    const NS_SCREEN_SAVER_WINDOW_LEVEL: ObjcInteger = 1000;
    const NS_NORMAL_WINDOW_LEVEL: ObjcInteger = 0;
    const NS_WINDOW_COLLECTION_CAN_JOIN_ALL_SPACES: ObjcUnsigned = 1 << 0;
    const NS_WINDOW_COLLECTION_TRANSIENT: ObjcUnsigned = 1 << 3;
    const NS_WINDOW_COLLECTION_FULL_SCREEN_AUXILIARY: ObjcUnsigned = 1 << 8;
    const NS_WINDOW_STYLE_TITLED: ObjcUnsigned = 1 << 0;
    const NS_WINDOW_STYLE_RESIZABLE: ObjcUnsigned = 1 << 3;
    const NS_WINDOW_STYLE_MINIATURIZABLE: ObjcUnsigned = 1 << 2;
    const NS_WINDOW_STYLE_FULL_SIZE_CONTENT: ObjcUnsigned = 1 << 15;
    const NS_WINDOW_TITLE_HIDDEN: ObjcInteger = 1;
    const NS_APPLICATION_ACTIVATION_POLICY_REGULAR: ObjcInteger = 0;
    const NS_VISUAL_EFFECT_MATERIAL_SIDEBAR: ObjcInteger = 7;
    const NS_VISUAL_EFFECT_BLENDING_BEHIND_WINDOW: ObjcInteger = 0;
    const NS_VISUAL_EFFECT_STATE_ACTIVE: ObjcInteger = 1;
    const NS_VIEW_WIDTH_SIZABLE: ObjcUnsigned = 1 << 1;
    const NS_VIEW_HEIGHT_SIZABLE: ObjcUnsigned = 1 << 4;
    const WORKSPACE_EFFECT_VIEW_ID: &CStr = c"emma.workspace.vibrancy";

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct NsPoint {
        x: f64,
        y: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct NsSize {
        width: f64,
        height: f64,
    }

    #[repr(C)]
    #[derive(Clone, Copy, Debug, Default)]
    struct NsRect {
        origin: NsPoint,
        size: NsSize,
    }

    #[link(name = "objc")]
    unsafe extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn objc_msgSend();
        fn sel_registerName(name: *const c_char) -> Sel;
        #[cfg(target_arch = "x86_64")]
        fn objc_msgSend_stret();
    }

    #[derive(Clone, Copy)]
    pub(super) struct DisplaySnapshot {
        pub display: NativeDisplay,
        frame: NsRect,
    }

    pub(super) fn apply(
        command: &NativeWindowCommand,
        controller: &NativeWindowController,
        cx: &mut App,
    ) -> Result<(), NativeWindowAdapterError> {
        match command {
            NativeWindowCommand::Show { role, inactive } => {
                with_role(*role, controller, cx, |window, _spec| {
                    if *inactive {
                        send_void(window, selector(c"orderFrontRegardless"));
                    } else {
                        send_void_id(window, selector(c"makeKeyAndOrderFront:"), ptr::null_mut());
                    }
                    Ok(())
                })
            }
            NativeWindowCommand::Hide { role } => {
                with_role(*role, controller, cx, |window, _spec| {
                    send_void_id(window, selector(c"orderOut:"), ptr::null_mut());
                    Ok(())
                })
            }
            NativeWindowCommand::Close { role } => {
                with_role(*role, controller, cx, |window, spec| {
                    if spec.role == NativeWindowRole::Workspace {
                        remove_workspace_material(window);
                    }
                    send_void(window, selector(c"close"));
                    Ok(())
                })
            }
            NativeWindowCommand::Focus { role } => {
                with_role(*role, controller, cx, |window, _spec| {
                    send_void_id(window, selector(c"makeKeyAndOrderFront:"), ptr::null_mut());
                    Ok(())
                })
            }
            NativeWindowCommand::SetBounds { role, bounds } => {
                let bounds = *bounds;
                with_role(*role, controller, cx, |window, spec| {
                    set_bounds(
                        window,
                        bounds,
                        spec.display_id,
                        spec.role == NativeWindowRole::ComputerActivityCursor
                            && spec.display_id.is_none(),
                    );
                    Ok(())
                })
            }
            NativeWindowCommand::SetIgnoreMouseEvents { role, ignore, .. } => {
                with_role(*role, controller, cx, |window, _spec| {
                    send_void_bool(
                        window,
                        selector(c"setIgnoresMouseEvents:"),
                        if *ignore { YES } else { NO },
                    );
                    Ok(())
                })
            }
            NativeWindowCommand::SetHiddenInMissionControl { role, hidden } => {
                with_role(*role, controller, cx, |window, _spec| {
                    set_hidden_in_mission_control(window, *hidden);
                    Ok(())
                })
            }
            NativeWindowCommand::MoveAbove {
                role,
                target_window_id,
            } => with_role(*role, controller, cx, |window, _spec| {
                send_void_integer_integer(
                    window,
                    selector(c"orderWindow:relativeTo:"),
                    NS_WINDOW_ABOVE,
                    *target_window_id as ObjcInteger,
                );
                Ok(())
            }),
            NativeWindowCommand::ActivateApplication { steal } => {
                activate_application(*steal);
                Ok(())
            }
            _ => Ok(()),
        }
    }

    pub(super) fn configure(
        handle: AnyWindowHandle,
        spec: &NativeWindowSpec,
        cx: &mut App,
    ) -> Result<(), NativeWindowAdapterError> {
        let result = handle.update(cx, |_view, window, _cx| {
            let native_window = window_for_gpui(window)?;
            configure_native_window(native_window, spec);
            Ok::<(), NativeWindowAdapterError>(())
        });
        match result {
            Ok(result) => result,
            Err(error) => Err(NativeWindowAdapterError::Gpui(SharedError::from(
                error.to_string(),
            ))),
        }
    }

    fn with_role<T>(
        role: crate::native_windows::NativeWindowRole,
        controller: &NativeWindowController,
        cx: &mut App,
        operation: impl FnOnce(Id, &NativeWindowSpec) -> Result<T, NativeWindowAdapterError>,
    ) -> Result<T, NativeWindowAdapterError> {
        let Some(record) = controller.record(role) else {
            return Err(NativeWindowAdapterError::MissingWindow(role));
        };
        let Some(handle) = record.handle else {
            return Err(NativeWindowAdapterError::MissingWindow(role));
        };
        let spec = record.spec.clone();
        let result = handle.update(cx, |_view, window, _cx| {
            let native_window = window_for_gpui(window)?;
            operation(native_window, &spec)
        });
        match result {
            Ok(result) => result,
            Err(error) => Err(NativeWindowAdapterError::Gpui(SharedError::from(
                error.to_string(),
            ))),
        }
    }

    fn window_for_gpui(window: &Window) -> Result<Id, NativeWindowAdapterError> {
        let handle = HasWindowHandle::window_handle(window).map_err(|_| {
            NativeWindowAdapterError::Native("GPUI did not expose an AppKit handle")
        })?;
        let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
            return Err(NativeWindowAdapterError::Native(
                "GPUI returned a non-AppKit window handle",
            ));
        };
        let window = send_id(handle.ns_view.as_ptr(), selector(c"window"));
        if window.is_null() {
            Err(NativeWindowAdapterError::Native(
                "GPUI AppKit view is not attached to an NSWindow",
            ))
        } else {
            Ok(window)
        }
    }

    fn configure_native_window(window: Id, spec: &NativeWindowSpec) {
        if !spec.flags.decorated {
            let style = send_unsigned(window, selector(c"styleMask"));
            send_void_unsigned(
                window,
                selector(c"setStyleMask:"),
                style & !(NS_WINDOW_STYLE_TITLED | NS_WINDOW_STYLE_FULL_SIZE_CONTENT),
            );
        }
        if !spec.flags.resizable {
            let style = send_unsigned(window, selector(c"styleMask"));
            send_void_unsigned(
                window,
                selector(c"setStyleMask:"),
                style & !NS_WINDOW_STYLE_RESIZABLE,
            );
        }
        if !spec.flags.minimizable {
            let style = send_unsigned(window, selector(c"styleMask"));
            send_void_unsigned(
                window,
                selector(c"setStyleMask:"),
                style & !NS_WINDOW_STYLE_MINIATURIZABLE,
            );
        }
        send_void_bool(
            window,
            selector(c"setMovable:"),
            if spec.flags.movable { YES } else { NO },
        );
        send_void_bool(
            window,
            selector(c"setMovableByWindowBackground:"),
            if spec.flags.movable { YES } else { NO },
        );
        send_void_bool(
            window,
            selector(c"setHasShadow:"),
            if spec.flags.has_shadow { YES } else { NO },
        );
        send_void_bool(window, selector(c"setHidesOnDeactivate:"), NO);
        send_void_bool(
            window,
            selector(c"setExcludedFromWindowsMenu:"),
            if spec.flags.skip_taskbar { YES } else { NO },
        );
        send_void_bool(
            window,
            selector(c"setCanHide:"),
            if spec.flags.skip_taskbar { NO } else { YES },
        );
        send_void_bool(
            window,
            selector(c"setIgnoresMouseEvents:"),
            if spec.flags.mouse_events_ignored || spec.flags.click_through {
                YES
            } else {
                NO
            },
        );
        let workspace_material = (spec.role == NativeWindowRole::Workspace
            && spec.titlebar_transparent)
            .then(|| super::workspace_material_for(reduce_transparency()));
        match workspace_material {
            Some(super::WorkspaceMaterial::SidebarActive) => {
                configure_transparent_window(window);
                install_workspace_material(window);
            }
            Some(super::WorkspaceMaterial::Opaque) => {
                remove_workspace_material(window);
                send_void_bool(window, selector(c"setOpaque:"), YES);
            }
            None if spec.flags.transparent => configure_transparent_window(window),
            None => send_void_bool(window, selector(c"setOpaque:"), YES),
        }
        if spec.titlebar_transparent {
            send_void_bool(window, selector(c"setTitlebarAppearsTransparent:"), YES);
            send_void_integer(
                window,
                selector(c"setTitleVisibility:"),
                NS_WINDOW_TITLE_HIDDEN,
            );
        }
        let mut behavior = send_unsigned(window, selector(c"collectionBehavior"));
        let spaces =
            NS_WINDOW_COLLECTION_CAN_JOIN_ALL_SPACES | NS_WINDOW_COLLECTION_FULL_SCREEN_AUXILIARY;
        if spec.flags.all_workspaces {
            behavior |= spaces;
        } else {
            behavior &= !spaces;
        }
        if spec.flags.hidden_in_mission_control {
            behavior |= NS_WINDOW_COLLECTION_TRANSIENT;
        } else {
            behavior &= !NS_WINDOW_COLLECTION_TRANSIENT;
        }
        send_void_unsigned(window, selector(c"setCollectionBehavior:"), behavior);
        send_void_integer(
            window,
            selector(c"setLevel:"),
            if spec.flags.always_on_top {
                NS_SCREEN_SAVER_WINDOW_LEVEL
            } else {
                NS_NORMAL_WINDOW_LEVEL
            },
        );
        if !spec.flags.rounded_corners {
            let content_view = send_id(window, selector(c"contentView"));
            if !content_view.is_null() {
                send_void_bool(content_view, selector(c"setWantsLayer:"), YES);
                let layer = send_id(content_view, selector(c"layer"));
                if !layer.is_null() {
                    send_void_f64(layer, selector(c"setCornerRadius:"), 0.);
                }
            }
        }
    }

    fn configure_transparent_window(window: Id) {
        send_void_bool(window, selector(c"setOpaque:"), NO);
        let color_class = class(c"NSColor");
        let clear = send_id(color_class, selector(c"clearColor"));
        send_void_id(window, selector(c"setBackgroundColor:"), clear);
    }

    fn reduce_transparency() -> bool {
        let workspace_class = class(c"NSWorkspace");
        if workspace_class.is_null() {
            return false;
        }
        let workspace = send_id(workspace_class, selector(c"sharedWorkspace"));
        if workspace.is_null() {
            return false;
        }
        let preference = selector(c"accessibilityDisplayShouldReduceTransparency");
        if send_bool_sel(workspace, selector(c"respondsToSelector:"), preference) != YES {
            return false;
        }
        send_bool(workspace, preference) == YES
    }

    fn install_workspace_material(window: Id) {
        let content_view = send_id(window, selector(c"contentView"));
        if content_view.is_null() {
            return;
        }
        let effect = workspace_effect_view(content_view).or_else(|| {
            let effect_class = class(c"NSVisualEffectView");
            if effect_class.is_null() {
                return None;
            }
            let allocated = send_id(effect_class, selector(c"alloc"));
            if allocated.is_null() {
                return None;
            }
            let effect = send_id(allocated, selector(c"init"));
            if effect.is_null() {
                return None;
            }
            let identifier_selector = selector(c"setIdentifier:");
            if send_bool_sel(
                effect,
                selector(c"respondsToSelector:"),
                identifier_selector,
            ) == YES
            {
                let identifier_class = class(c"NSString");
                let identifier = send_id_ptr(
                    identifier_class,
                    selector(c"stringWithUTF8String:"),
                    WORKSPACE_EFFECT_VIEW_ID.as_ptr(),
                );
                send_void_id(effect, identifier_selector, identifier);
            }
            send_void_id_integer_id(
                content_view,
                selector(c"addSubview:position:relativeTo:"),
                effect,
                NS_WINDOW_BELOW,
                ptr::null_mut(),
            );
            send_void(effect, selector(c"release"));
            Some(effect)
        });
        let Some(effect) = effect else {
            return;
        };
        let bounds = send_rect(content_view, selector(c"bounds"));
        send_void_rect(effect, selector(c"setFrame:"), bounds);
        send_void_unsigned(
            effect,
            selector(c"setAutoresizingMask:"),
            NS_VIEW_WIDTH_SIZABLE | NS_VIEW_HEIGHT_SIZABLE,
        );
        send_void_integer(
            effect,
            selector(c"setMaterial:"),
            NS_VISUAL_EFFECT_MATERIAL_SIDEBAR,
        );
        send_void_integer(
            effect,
            selector(c"setBlendingMode:"),
            NS_VISUAL_EFFECT_BLENDING_BEHIND_WINDOW,
        );
        send_void_integer(
            effect,
            selector(c"setState:"),
            NS_VISUAL_EFFECT_STATE_ACTIVE,
        );
        send_void_bool(effect, selector(c"setEmphasized:"), NO);
        let accessibility_selector = selector(c"setAccessibilityElement:");
        if send_bool_sel(
            effect,
            selector(c"respondsToSelector:"),
            accessibility_selector,
        ) == YES
        {
            send_void_bool(effect, accessibility_selector, NO);
        }
    }

    fn workspace_effect_view(content_view: Id) -> Option<Id> {
        let subviews = send_id(content_view, selector(c"subviews"));
        if subviews.is_null() {
            return None;
        }
        let effect_class = class(c"NSVisualEffectView");
        if effect_class.is_null() {
            return None;
        }
        let identifier_class = class(c"NSString");
        let identifier = send_id_ptr(
            identifier_class,
            selector(c"stringWithUTF8String:"),
            WORKSPACE_EFFECT_VIEW_ID.as_ptr(),
        );
        let count = send_unsigned(subviews, selector(c"count"));
        (0..count).find_map(|index| {
            let candidate = send_id_unsigned(subviews, selector(c"objectAtIndex:"), index);
            if candidate.is_null()
                || send_bool_id(candidate, selector(c"isKindOfClass:"), effect_class) != YES
            {
                return None;
            }
            let candidate_identifier = send_id(candidate, selector(c"identifier"));
            if !candidate_identifier.is_null()
                && send_bool_id(
                    candidate_identifier,
                    selector(c"isEqualToString:"),
                    identifier,
                ) == YES
            {
                Some(candidate)
            } else {
                None
            }
        })
    }

    fn remove_workspace_material(window: Id) {
        let content_view = send_id(window, selector(c"contentView"));
        if content_view.is_null() {
            return;
        }
        if let Some(effect) = workspace_effect_view(content_view) {
            send_void(effect, selector(c"removeFromSuperview"));
        }
    }

    fn set_bounds(
        window: Id,
        bounds: SurfaceRect,
        display_id: Option<u64>,
        global_coordinates: bool,
    ) {
        let current = || {
            let current = send_id(window, selector(c"screen"));
            (!current.is_null()).then_some(current)
        };
        let screen = if global_coordinates {
            screen_for_global_bounds(bounds).or_else(current)
        } else {
            display_id.and_then(screen_for_display_id).or_else(current)
        }
        .or_else(|| {
            let screen_class = class(c"NSScreen");
            let main = send_id(screen_class, selector(c"mainScreen"));
            (!main.is_null()).then_some(main)
        });
        let Some(screen) = screen else {
            return;
        };
        let frame = send_rect(screen, selector(c"frame"));
        let native_frame = if global_coordinates {
            global_cursor_frame(bounds, primary_screen_top())
        } else {
            NsRect {
                origin: NsPoint {
                    x: frame.origin.x + bounds.x as f64,
                    y: frame.origin.y + frame.size.height - bounds.y as f64 - bounds.height as f64,
                },
                size: NsSize {
                    width: bounds.width as f64,
                    height: bounds.height as f64,
                },
            }
        };
        send_void_rect_bool_bool(
            window,
            selector(c"setFrame:display:animate:"),
            native_frame,
            YES,
            NO,
        );
    }

    fn global_cursor_frame(bounds: SurfaceRect, primary_top: f64) -> NsRect {
        NsRect {
            origin: NsPoint {
                x: bounds.x as f64,
                y: primary_top - bounds.y as f64 - bounds.height as f64,
            },
            size: NsSize {
                width: bounds.width as f64,
                height: bounds.height as f64,
            },
        }
    }

    fn primary_screen_top() -> f64 {
        let main = send_id(class(c"NSScreen"), selector(c"mainScreen"));
        if main.is_null() {
            0.
        } else {
            let frame = send_rect(main, selector(c"frame"));
            frame.origin.y + frame.size.height
        }
    }

    fn screen_for_global_bounds(bounds: SurfaceRect) -> Option<Id> {
        let primary_top = primary_screen_top();
        let point = NsPoint {
            x: bounds.x as f64 + bounds.width as f64 * 0.5,
            y: primary_top - bounds.y as f64 - bounds.height as f64 * 0.5,
        };
        let screens = send_id(class(c"NSScreen"), selector(c"screens"));
        if screens.is_null() {
            return None;
        }
        let count = send_unsigned(screens, selector(c"count"));
        (0..count)
            .map(|index| send_id_unsigned(screens, selector(c"objectAtIndex:"), index))
            .find(|screen| {
                if screen.is_null() {
                    return false;
                }
                let frame = send_rect(*screen, selector(c"frame"));
                point.x >= frame.origin.x
                    && point.x <= frame.origin.x + frame.size.width
                    && point.y >= frame.origin.y
                    && point.y <= frame.origin.y + frame.size.height
            })
    }

    fn set_hidden_in_mission_control(window: Id, hidden: bool) {
        let mut behavior = send_unsigned(window, selector(c"collectionBehavior"));
        if hidden {
            behavior |= NS_WINDOW_COLLECTION_TRANSIENT;
        } else {
            behavior &= !NS_WINDOW_COLLECTION_TRANSIENT;
        }
        send_void_unsigned(window, selector(c"setCollectionBehavior:"), behavior);
    }

    fn activate_application(steal: bool) {
        let app_class = class(c"NSApplication");
        let app = send_id(app_class, selector(c"sharedApplication"));
        if !app.is_null() {
            send_void_integer(
                app,
                selector(c"setActivationPolicy:"),
                NS_APPLICATION_ACTIVATION_POLICY_REGULAR,
            );
            send_void_bool(
                app,
                selector(c"activateIgnoringOtherApps:"),
                if steal { YES } else { NO },
            );
        }
    }

    pub(super) fn display_snapshots() -> Vec<DisplaySnapshot> {
        let screen_class = class(c"NSScreen");
        let screens = send_id(screen_class, selector(c"screens"));
        if screens.is_null() {
            return Vec::new();
        }
        let count = send_unsigned(screens, selector(c"count"));
        let mut snapshots = Vec::with_capacity(count as usize);
        for index in 0..count {
            let screen = send_id_unsigned(screens, selector(c"objectAtIndex:"), index);
            if screen.is_null() {
                continue;
            }
            let frame = send_rect(screen, selector(c"frame"));
            let visible = send_rect(screen, selector(c"visibleFrame"));
            let Some(id) = screen_display_id(screen) else {
                continue;
            };
            snapshots.push(DisplaySnapshot {
                display: NativeDisplay::new(
                    id,
                    DisplayGeometry {
                        bounds: SurfaceRect::new(
                            0.,
                            0.,
                            frame.size.width as f32,
                            frame.size.height as f32,
                        ),
                        work_area: SurfaceRect::new(
                            (visible.origin.x - frame.origin.x) as f32,
                            (frame.origin.y + frame.size.height
                                - visible.origin.y
                                - visible.size.height) as f32,
                            visible.size.width as f32,
                            visible.size.height as f32,
                        ),
                    },
                ),
                frame,
            });
        }
        snapshots
    }

    pub(super) fn primary_display_id() -> Option<u64> {
        let screen = send_id(class(c"NSScreen"), selector(c"mainScreen"));
        if screen.is_null() {
            None
        } else {
            screen_display_id(screen)
        }
    }

    pub(super) fn cursor_screen_point()
    -> Result<(NativeDisplay, GeometryPoint), NativeWindowAdapterError> {
        let event_class = class(c"NSEvent");
        let point = send_point(event_class, selector(c"mouseLocation"));
        display_snapshots()
            .into_iter()
            .find(|snapshot| {
                point.x >= snapshot.frame.origin.x
                    && point.x <= snapshot.frame.origin.x + snapshot.frame.size.width
                    && point.y >= snapshot.frame.origin.y
                    && point.y <= snapshot.frame.origin.y + snapshot.frame.size.height
            })
            .map(|snapshot| {
                let local_y = snapshot.frame.origin.y + snapshot.frame.size.height - point.y;
                (
                    snapshot.display,
                    GeometryPoint {
                        x: (point.x - snapshot.frame.origin.x) as f32,
                        y: local_y as f32,
                    },
                )
            })
            .ok_or(NativeWindowAdapterError::Native(
                "AppKit returned no display for the cursor position",
            ))
    }

    pub(super) fn frontmost_application() -> Option<String> {
        let workspace_class = class(c"NSWorkspace");
        let workspace = send_id(workspace_class, selector(c"sharedWorkspace"));
        if workspace.is_null() {
            return None;
        }
        let application = send_id(workspace, selector(c"frontmostApplication"));
        if application.is_null() {
            return None;
        }
        let name = send_id(application, selector(c"localizedName"));
        ns_string(name).or_else(|| ns_string(send_id(application, selector(c"bundleIdentifier"))))
    }

    fn screen_for_display_id(display_id: u64) -> Option<Id> {
        let screen_class = class(c"NSScreen");
        let screens = send_id(screen_class, selector(c"screens"));
        if screens.is_null() {
            return None;
        }
        let count = send_unsigned(screens, selector(c"count"));
        (0..count)
            .map(|index| send_id_unsigned(screens, selector(c"objectAtIndex:"), index))
            .find(|screen| !screen.is_null() && screen_display_id(*screen) == Some(display_id))
    }

    fn screen_display_id(screen: Id) -> Option<u64> {
        let description = send_id(screen, selector(c"deviceDescription"));
        if description.is_null() {
            return None;
        }
        let key_class = class(c"NSString");
        let key = send_id_ptr(
            key_class,
            selector(c"stringWithUTF8String:"),
            c"NSScreenNumber".as_ptr(),
        );
        let number = send_id_id(description, selector(c"objectForKey:"), key);
        if number.is_null() {
            None
        } else {
            Some(send_unsigned(number, selector(c"unsignedIntegerValue")))
        }
    }

    fn ns_string(value: Id) -> Option<String> {
        if value.is_null() {
            return None;
        }
        let string = send_const_char(value, selector(c"UTF8String"));
        if string.is_null() {
            None
        } else {
            Some(
                unsafe { CStr::from_ptr(string) }
                    .to_string_lossy()
                    .into_owned(),
            )
        }
    }

    fn class(name: &'static CStr) -> Id {
        unsafe { objc_getClass(name.as_ptr()) }
    }

    fn selector(name: &'static CStr) -> Sel {
        unsafe { sel_registerName(name.as_ptr()) }
    }

    fn send_void(receiver: Id, selector: Sel) {
        let function: unsafe extern "C" fn(Id, Sel) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) };
    }

    fn send_id(receiver: Id, selector: Sel) -> Id {
        let function: unsafe extern "C" fn(Id, Sel) -> Id =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    fn send_bool(receiver: Id, selector: Sel) -> ObjcBool {
        let function: unsafe extern "C" fn(Id, Sel) -> ObjcBool =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    fn send_bool_sel(receiver: Id, selector: Sel, value: Sel) -> ObjcBool {
        let function: unsafe extern "C" fn(Id, Sel, Sel) -> ObjcBool =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    fn send_bool_id(receiver: Id, selector: Sel, value: Id) -> ObjcBool {
        let function: unsafe extern "C" fn(Id, Sel, Id) -> ObjcBool =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    fn send_unsigned(receiver: Id, selector: Sel) -> ObjcUnsigned {
        let function: unsafe extern "C" fn(Id, Sel) -> ObjcUnsigned =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    fn send_point(receiver: Id, selector: Sel) -> NsPoint {
        let function: unsafe extern "C" fn(Id, Sel) -> NsPoint =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    fn send_rect(receiver: Id, selector: Sel) -> NsRect {
        let function: unsafe extern "C" fn(Id, Sel) -> NsRect = unsafe {
            #[cfg(target_arch = "x86_64")]
            {
                transmute(objc_msgSend_stret as *const ())
            }
            #[cfg(not(target_arch = "x86_64"))]
            {
                transmute(objc_msgSend as *const ())
            }
        };
        unsafe { function(receiver, selector) }
    }

    fn send_id_unsigned(receiver: Id, selector: Sel, value: ObjcUnsigned) -> Id {
        let function: unsafe extern "C" fn(Id, Sel, ObjcUnsigned) -> Id =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    fn send_id_id(receiver: Id, selector: Sel, value: Id) -> Id {
        let function: unsafe extern "C" fn(Id, Sel, Id) -> Id =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    fn send_id_ptr(receiver: Id, selector: Sel, value: *const c_char) -> Id {
        let function: unsafe extern "C" fn(Id, Sel, *const c_char) -> Id =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) }
    }

    fn send_const_char(receiver: Id, selector: Sel) -> *const c_char {
        let function: unsafe extern "C" fn(Id, Sel) -> *const c_char =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector) }
    }

    fn send_void_bool(receiver: Id, selector: Sel, value: ObjcBool) {
        let function: unsafe extern "C" fn(Id, Sel, ObjcBool) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) };
    }

    fn send_void_unsigned(receiver: Id, selector: Sel, value: ObjcUnsigned) {
        let function: unsafe extern "C" fn(Id, Sel, ObjcUnsigned) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) };
    }

    fn send_void_integer(receiver: Id, selector: Sel, value: ObjcInteger) {
        let function: unsafe extern "C" fn(Id, Sel, ObjcInteger) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) };
    }

    fn send_void_integer_integer(
        receiver: Id,
        selector: Sel,
        first: ObjcInteger,
        second: ObjcInteger,
    ) {
        let function: unsafe extern "C" fn(Id, Sel, ObjcInteger, ObjcInteger) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, first, second) };
    }

    fn send_void_id(receiver: Id, selector: Sel, value: Id) {
        let function: unsafe extern "C" fn(Id, Sel, Id) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) };
    }

    fn send_void_id_integer_id(
        receiver: Id,
        selector: Sel,
        first: Id,
        second: ObjcInteger,
        third: Id,
    ) {
        let function: unsafe extern "C" fn(Id, Sel, Id, ObjcInteger, Id) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, first, second, third) };
    }

    fn send_void_f64(receiver: Id, selector: Sel, value: f64) {
        let function: unsafe extern "C" fn(Id, Sel, f64) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, value) };
    }

    fn send_void_rect(receiver: Id, selector: Sel, rect: NsRect) {
        let function: unsafe extern "C" fn(Id, Sel, NsRect) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, rect) };
    }

    fn send_void_rect_bool_bool(
        receiver: Id,
        selector: Sel,
        rect: NsRect,
        display: ObjcBool,
        animate: ObjcBool,
    ) {
        let function: unsafe extern "C" fn(Id, Sel, NsRect, ObjcBool, ObjcBool) =
            unsafe { transmute(objc_msgSend as *const ()) };
        unsafe { function(receiver, selector, rect, display, animate) };
    }

    #[cfg(test)]
    mod tests {
        use super::*;

        #[test]
        fn global_cursor_frames_flip_into_appkit_coordinates() {
            let frame = global_cursor_frame(SurfaceRect::new(-100., 20., 40., 30.), 900.);
            assert_eq!(frame.origin.x, -100.);
            assert_eq!(frame.origin.y, 850.);
            assert_eq!(frame.size.width, 40.);
            assert_eq!(frame.size.height, 30.);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native_windows::NativeWindowSpec;

    #[test]
    fn command_routing_keeps_native_and_application_ownership_distinct() {
        assert_eq!(
            NativeWindowAdapter::command_disposition(&NativeWindowCommand::Show {
                role: NativeWindowRole::QuickAsk,
                inactive: true,
            }),
            NativeWindowCommandDisposition::Native
        );
        assert_eq!(
            NativeWindowAdapter::command_disposition(&NativeWindowCommand::Open(Box::new(
                NativeWindowSpec::computer_activity_cursor(NativeHostPlatform::MacOS, false),
            ))),
            NativeWindowCommandDisposition::RootOwned(NativeWindowRole::ComputerActivityCursor)
        );
        assert_eq!(
            NativeWindowAdapter::command_disposition(&NativeWindowCommand::DispatchQuickAsk(
                "summarize".into(),
            )),
            NativeWindowCommandDisposition::ApplicationOwned
        );
        assert_eq!(
            NativeWindowAdapter::command_disposition(&NativeWindowCommand::ScheduleCursorHide(
                1400
            )),
            NativeWindowCommandDisposition::TimerOwned(NativeWindowTimer::ComputerCursor)
        );
    }

    #[test]
    fn notch_input_remains_validated_at_the_adapter_boundary() {
        let adapter = NativeWindowAdapter::new(NativeHostPlatform::MacOS);
        let result = adapter
            .parse_notch_line(r#"[{"id":7,"x":600,"width":180,"height":32}]"#)
            .unwrap();
        assert_eq!(result[0].id, 7.);
        assert!(
            adapter
                .parse_notch_line(r#"[{"id":7,"x":600,"width":20,"height":32}]"#)
                .is_err()
        );
    }

    #[test]
    fn workspace_material_has_an_opaque_accessibility_fallback() {
        assert_eq!(
            workspace_material_for(false),
            WorkspaceMaterial::SidebarActive
        );
        assert_eq!(workspace_material_for(true), WorkspaceMaterial::Opaque);
        assert!(workspace_material_for(false).is_translucent());
        assert!(!workspace_material_for(true).is_translucent());
    }
}
