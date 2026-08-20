use emma_core::LiveClient;
use emma_ui::{
    ActivateFocused, AgentSurfaceView, Analyze, Cancel, DismissAgentSurface, FocusNext,
    FocusPrevious, LibraryView, OverlayPlacement, ScreenRect, SurfacePreferences,
    ToggleAgentSurface, agent_surface_bounds,
};
use gpui::{
    App, AppContext, Bounds, KeyBinding, Menu, MenuItem, WindowBackgroundAppearance, WindowBounds,
    WindowKind, WindowOptions, actions, point, px, size,
};
use gpui_platform::application;

actions!(emma, [Quit]);

const SURFACE_WIDTH: f32 = 480.0;
const SURFACE_HEIGHT: f32 = 220.0;

fn open_library(cx: &mut App, live: LiveClient) {
    let bounds = Bounds::centered(None, size(px(1040.0), px(700.0)), cx);
    cx.open_window(
        WindowOptions {
            focus: true,
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        },
        move |window, cx| cx.new(|cx| LibraryView::new(live, window, cx)),
    )
    .expect("open Emma library window");
}

fn close_agent_surface(cx: &mut App) -> bool {
    let Some(handle) = cx
        .windows()
        .into_iter()
        .find_map(|window| window.downcast::<AgentSurfaceView>())
    else {
        return false;
    };

    handle
        .update(cx, |_, window, _| window.remove_window())
        .is_ok()
}

fn toggle_agent_surface(_: &ToggleAgentSurface, live: &LiveClient, cx: &mut App) {
    if close_agent_surface(cx) {
        return;
    }

    let display = cx.primary_display().map(|display| display.visible_bounds());
    let display = display
        .unwrap_or_else(|| Bounds::new(point(px(0.0), px(0.0)), size(px(1440.0), px(900.0))));
    let bounds = agent_surface_bounds(
        ScreenRect {
            x: display.origin.x.into(),
            y: display.origin.y.into(),
            width: display.size.width.into(),
            height: display.size.height.into(),
        },
        SURFACE_WIDTH,
        SURFACE_HEIGHT,
        OverlayPlacement::UnderNotch,
    );

    cx.open_window(
        WindowOptions {
            titlebar: None,
            focus: true,
            kind: WindowKind::PopUp,
            is_movable: false,
            is_resizable: false,
            is_minimizable: false,
            window_background: WindowBackgroundAppearance::Blurred,
            window_bounds: Some(WindowBounds::Windowed(Bounds::new(
                point(px(bounds.x), px(bounds.y)),
                size(px(bounds.width), px(bounds.height)),
            ))),
            ..Default::default()
        },
        {
            let live = live.clone();
            move |window, cx| {
                cx.new(|cx| AgentSurfaceView::new(live, SurfacePreferences::default(), window, cx))
            }
        },
    )
    .expect("open Emma agent surface");
    cx.activate(true);
}

fn quit(_: &Quit, cx: &mut App) {
    cx.quit();
}

mod global_hotkey;

pub mod capture {
    use std::process::Command;

    /// Constructs the native command boundary; callers must only request this
    /// after an explicit screenshot action. Merely opening/analyzing never runs it.
    pub fn screenshot_command(explicitly_requested: bool) -> Option<Command> {
        explicitly_requested.then(|| {
            let mut command = Command::new("/usr/sbin/screencapture");
            command.arg("-x").arg("-");
            command
        })
    }

    #[test]
    fn screenshot_is_off_without_explicit_action() {
        assert!(screenshot_command(false).is_none());
    }
}

fn main() {
    let live = runtime::start().expect("start Emma runtime");
    application().run(move |cx: &mut App| {
        gpui_base::init(cx);
        cx.on_action(quit);
        let surface_live = live.clone();
        cx.on_action(move |action, cx| toggle_agent_surface(action, &surface_live, cx));
        cx.bind_keys([
            KeyBinding::new("cmd-shift-space", ToggleAgentSurface, None),
            KeyBinding::new("escape", DismissAgentSurface, Some("AgentSurface")),
            KeyBinding::new("enter", ActivateFocused, Some("AgentSurface")),
            KeyBinding::new("space", ActivateFocused, Some("AgentSurfaceButton")),
            KeyBinding::new("tab", FocusNext, Some("AgentSurface")),
            KeyBinding::new("shift-tab", FocusPrevious, Some("AgentSurface")),
            KeyBinding::new("cmd-enter", Analyze, Some("AgentSurface")),
            KeyBinding::new("cmd-period", Cancel, Some("AgentSurface")),
            KeyBinding::new("enter", ActivateFocused, Some("LibraryShell")),
            KeyBinding::new("space", ActivateFocused, Some("LibraryButton")),
            KeyBinding::new("tab", FocusNext, Some("LibraryShell")),
            KeyBinding::new("shift-tab", FocusPrevious, Some("LibraryShell")),
            KeyBinding::new("cmd-q", Quit, None),
        ]);
        cx.set_menus([Menu::new("Emma").items([
            MenuItem::action("Toggle Agent Surface", ToggleAgentSurface),
            MenuItem::action("Quit Emma", Quit),
        ])]);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        if let Err(reason) = global_hotkey::install_command_shift_space(cx) {
            eprintln!("Emma: {reason}; typed in-app shortcut remains active");
        }
        open_library(cx, live.clone());
        cx.activate(true);
    });
}

mod runtime;
