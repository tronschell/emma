use emma_core::{AppPreferences, OverlayPlacement};
use gpui::{Context, FocusHandle, FontWeight, Render, Role, Window, div, prelude::*, px, rgb};

pub struct LibraryView {
    focus: FocusHandle,
    preferences: AppPreferences,
}

impl LibraryView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let focus = cx.focus_handle();
        focus.focus(window, cx);
        Self {
            focus,
            preferences: AppPreferences::default(),
        }
    }
}

impl Render for LibraryView {
    fn render(&mut self, _window: &mut Window, _cx: &mut Context<Self>) -> impl IntoElement {
        let placement = match self.preferences.overlay_placement {
            OverlayPlacement::LeftOfNotch => "Left of notch",
            OverlayPlacement::RightOfNotch => "Right of notch",
            OverlayPlacement::UnderNotch => "Under notch",
        };

        div()
            .id("emma-library")
            .accessibility_id("emma.library")
            .role(Role::Application)
            .aria_label("Emma knowledge library")
            .track_focus(&self.focus)
            .size_full()
            .flex()
            .bg(rgb(0x0d0f12))
            .text_color(rgb(0xf4f5f7))
            .child(
                div()
                    .w(px(232.0))
                    .h_full()
                    .flex()
                    .flex_col()
                    .gap(px(18.0))
                    .p(px(20.0))
                    .border_r_1()
                    .border_color(rgb(0x252a31))
                    .bg(rgb(0x14171b))
                    .child(
                        div()
                            .text_size(px(19.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Emma"),
                    )
                    .child(
                        div()
                            .id("library-empty")
                            .role(Role::Status)
                            .aria_label("No saved pages")
                            .text_size(px(13.0))
                            .text_color(rgb(0x969da8))
                            .child("No saved pages yet"),
                    )
                    .child(
                        div()
                            .mt_auto()
                            .text_size(px(12.0))
                            .text_color(rgb(0x737b87))
                            .child(format!("Overlay: {placement}")),
                    ),
            )
            .child(
                div()
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .items_center()
                    .justify_center()
                    .child(
                        div()
                            .w(px(440.0))
                            .flex()
                            .flex_col()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .text_size(px(24.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child("Capture something worth keeping"),
                            )
                            .child(
                                div()
                                    .text_size(px(14.0))
                                    .text_color(rgb(0x969da8))
                                    .child("Press Command-Shift-Space from any app."),
                            ),
                    ),
            )
    }
}
