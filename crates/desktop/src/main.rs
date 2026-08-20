use emma_ui::LibraryView;
use gpui::{
    App, Bounds, KeyBinding, Menu, MenuItem, WindowBounds, WindowOptions, actions, px, size,
};
use gpui_platform::application;

actions!(emma, [Quit]);

fn open_library(cx: &mut App) {
    let bounds = Bounds::centered(None, size(px(1040.0), px(700.0)), cx);
    cx.open_window(
        WindowOptions {
            focus: true,
            window_bounds: Some(WindowBounds::Windowed(bounds)),
            ..Default::default()
        },
        |window, cx| cx.new(|cx| LibraryView::new(window, cx)),
    )
    .expect("open Emma library window");
}

fn quit(_: &Quit, cx: &mut App) {
    cx.quit();
}

fn main() {
    application().run(|cx: &mut App| {
        cx.on_action(quit);
        cx.bind_keys([KeyBinding::new("cmd-q", Quit, None)]);
        cx.set_menus([Menu::new("Emma").items([MenuItem::action("Quit Emma", Quit)])]);
        cx.on_window_closed(|cx, _| {
            if cx.windows().is_empty() {
                cx.quit();
            }
        })
        .detach();

        open_library(cx);
        cx.activate(true);
    });
}
