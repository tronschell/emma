use crate::{ActivateFocused, Analyze, Cancel, FocusNext, FocusPrevious};
use emma_core::OverlayPlacement;
use gpui::{
    Context, FocusHandle, FontWeight, Render, Role, Window, div, prelude::*, px, rgb, rgba,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ScreenRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

/// Places the surface around the top-center display anchor. This intentionally
/// does not claim hardware-notch discovery.
pub fn agent_surface_bounds(
    display: ScreenRect,
    surface_width: f32,
    surface_height: f32,
    placement: OverlayPlacement,
) -> ScreenRect {
    let gap = 12.0;
    let center_x = display.x + display.width / 2.0;
    let (x, y) = match placement {
        OverlayPlacement::LeftOfNotch => (center_x - gap - surface_width, display.y + gap),
        OverlayPlacement::RightOfNotch => (center_x + gap, display.y + gap),
        OverlayPlacement::UnderNotch => (center_x - surface_width / 2.0, display.y + 44.0),
    };

    ScreenRect {
        x: x.clamp(
            display.x,
            (display.x + display.width - surface_width).max(display.x),
        ),
        y: y.clamp(
            display.y,
            (display.y + display.height - surface_height).max(display.y),
        ),
        width: surface_width.min(display.width.max(0.0)),
        height: surface_height.min(display.height.max(0.0)),
    }
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum AgentSurfaceState {
    #[default]
    Ready,
    Analyzing,
    Saved,
    Failed,
}

impl AgentSurfaceState {
    fn label(self) -> &'static str {
        match self {
            Self::Ready => "Ready",
            Self::Analyzing => "Analyzing",
            Self::Saved => "Saved",
            Self::Failed => "Failed",
        }
    }

    fn transition(self, event: AgentSurfaceEvent) -> Self {
        match (self, event) {
            (Self::Analyzing, AgentSurfaceEvent::Cancel) => Self::Ready,
            (Self::Analyzing, AgentSurfaceEvent::Saved) => Self::Saved,
            (Self::Analyzing, AgentSurfaceEvent::Failed) => Self::Failed,
            (state, AgentSurfaceEvent::Analyze) if state != Self::Analyzing => Self::Analyzing,
            (state, _) => state,
        }
    }
}

#[derive(Clone, Copy)]
enum AgentSurfaceEvent {
    Analyze,
    Cancel,
    Saved,
    Failed,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct SurfacePreferences {
    pub reduce_transparency: bool,
    pub increase_contrast: bool,
}

#[derive(Clone, Copy)]
struct SurfaceTokens {
    background: gpui::Rgba,
    panel: gpui::Rgba,
    border: gpui::Rgba,
    secondary: gpui::Rgba,
}

impl SurfaceTokens {
    fn for_preferences(preferences: SurfacePreferences) -> Self {
        if preferences.increase_contrast {
            Self {
                background: rgba(0x090b0fff),
                panel: rgba(0x171b21ff),
                border: rgba(0xffffffff),
                secondary: rgba(0xd8dde5ff),
            }
        } else if preferences.reduce_transparency {
            Self {
                background: rgba(0x11151aff),
                panel: rgba(0x1d232bff),
                border: rgba(0x59616dff),
                secondary: rgba(0xaab2bdff),
            }
        } else {
            Self {
                background: rgba(0x11151aeb),
                panel: rgba(0x252b34d9),
                border: rgba(0xffffff24),
                secondary: rgba(0xb7bec9ff),
            }
        }
    }
}

pub struct AgentSurfaceView {
    state: AgentSurfaceState,
    root_focus: FocusHandle,
    analyze_focus: FocusHandle,
    cancel_focus: FocusHandle,
    preferences: SurfacePreferences,
}

impl AgentSurfaceView {
    pub fn new(
        preferences: SurfacePreferences,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let analyze_focus = cx.focus_handle();
        analyze_focus.focus(window, cx);
        Self {
            state: AgentSurfaceState::Ready,
            root_focus: cx.focus_handle(),
            analyze_focus,
            cancel_focus: cx.focus_handle(),
            preferences,
        }
    }

    pub fn state(&self) -> AgentSurfaceState {
        self.state
    }

    pub fn mark_saved(&mut self, cx: &mut Context<Self>) {
        self.transition(AgentSurfaceEvent::Saved, cx);
    }

    pub fn mark_failed(&mut self, cx: &mut Context<Self>) {
        self.transition(AgentSurfaceEvent::Failed, cx);
    }

    fn analyze(&mut self, _: &Analyze, _: &mut Window, cx: &mut Context<Self>) {
        self.transition(AgentSurfaceEvent::Analyze, cx);
    }

    fn cancel(&mut self, _: &Cancel, _: &mut Window, cx: &mut Context<Self>) {
        self.transition(AgentSurfaceEvent::Cancel, cx);
    }

    fn transition(&mut self, event: AgentSurfaceEvent, cx: &mut Context<Self>) {
        let next = self.state.transition(event);
        if next != self.state {
            self.state = next;
            cx.notify();
        }
    }

    fn activate_focused(
        &mut self,
        _: &ActivateFocused,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.analyze_focus.is_focused(window) {
            self.analyze(&Analyze, window, cx);
        } else if self.cancel_focus.is_focused(window) {
            self.cancel(&Cancel, window, cx);
        }
    }

    fn focus_next(&mut self, _: &FocusNext, window: &mut Window, cx: &mut Context<Self>) {
        window.focus_next(cx);
    }

    fn focus_previous(&mut self, _: &FocusPrevious, window: &mut Window, cx: &mut Context<Self>) {
        window.focus_prev(cx);
    }
}

impl Render for AgentSurfaceView {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tokens = SurfaceTokens::for_preferences(self.preferences);
        let analyzing = self.state == AgentSurfaceState::Analyzing;

        div()
            .id("agent-surface")
            .accessibility_id("emma.agent-surface")
            .key_context("AgentSurface")
            .role(Role::Dialog)
            .aria_label("Emma agent surface")
            .track_focus(&self.root_focus)
            .on_action(cx.listener(Self::analyze))
            .on_action(cx.listener(Self::cancel))
            .on_action(cx.listener(Self::activate_focused))
            .on_action(cx.listener(Self::focus_next))
            .on_action(cx.listener(Self::focus_previous))
            .size_full()
            .p(px(12.0))
            .bg(tokens.background)
            .text_color(rgb(0xf7f8fa))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(div().font_weight(FontWeight::SEMIBOLD).child("Emma"))
                    .child(
                        div()
                            .id("agent-status")
                            .role(Role::Status)
                            .aria_label(format!("Agent status: {}", self.state.label()))
                            .text_size(px(12.0))
                            .text_color(tokens.secondary)
                            .child(self.state.label()),
                    ),
            )
            .child(
                div()
                    .id("context-preview")
                    .role(Role::Group)
                    .aria_label("Context preview")
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(tokens.border)
                    .bg(tokens.panel)
                    .p(px(10.0))
                    .text_size(px(12.0))
                    .child("Fixture context · Safari · Example article selection"),
            )
            .child(
                div()
                    .id("prompt-placeholder")
                    .role(Role::TextInput)
                    .aria_label("Prompt entry unavailable")
                    .aria_placeholder("Ask Emma about this context")
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(tokens.border)
                    .p(px(10.0))
                    .text_size(px(13.0))
                    .text_color(tokens.secondary)
                    .child("Ask Emma about this context… (prompt entry deferred)"),
            )
            .child(
                div()
                    .mt_auto()
                    .flex()
                    .justify_end()
                    .gap(px(8.0))
                    .child(
                        div()
                            .id("cancel-analysis")
                            .accessibility_id("emma.agent.cancel")
                            .focusable()
                            .tab_stop(analyzing)
                            .track_focus(&self.cancel_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0x8fc7ff)))
                            .role(Role::Button)
                            .aria_label(if analyzing {
                                "Cancel analysis"
                            } else {
                                "Cancel analysis, unavailable"
                            })
                            .px(px(14.0))
                            .py(px(7.0))
                            .rounded(px(8.0))
                            .border_1()
                            .border_color(tokens.border)
                            .text_color(if analyzing {
                                rgb(0xf7f8fa)
                            } else {
                                rgb(0x777f8b)
                            })
                            .when(analyzing, |button| button.cursor_pointer())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.cancel_focus.focus(window, cx);
                                this.cancel(&Cancel, window, cx);
                            }))
                            .child("Cancel"),
                    )
                    .child(
                        div()
                            .id("analyze-context")
                            .accessibility_id("emma.agent.analyze")
                            .focusable()
                            .tab_stop(!analyzing)
                            .track_focus(&self.analyze_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0xffffff)))
                            .role(Role::Button)
                            .aria_label(if analyzing {
                                "Analyze context, unavailable while analyzing"
                            } else {
                                "Analyze fixture context"
                            })
                            .px(px(14.0))
                            .py(px(7.0))
                            .rounded(px(8.0))
                            .bg(if analyzing {
                                rgb(0x3a414b)
                            } else {
                                rgb(0x2f80ed)
                            })
                            .text_color(if analyzing {
                                rgb(0x9ba3ae)
                            } else {
                                rgb(0xffffff)
                            })
                            .when(!analyzing, |button| button.cursor_pointer())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.analyze_focus.focus(window, cx);
                                this.analyze(&Analyze, window, cx);
                            }))
                            .child(if analyzing { "Analyzing…" } else { "Analyze" }),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use gpui::TestAppContext;

    #[test]
    fn geometry_uses_each_display_center_placement_and_clamps() {
        let display = ScreenRect {
            x: 100.0,
            y: 20.0,
            width: 1200.0,
            height: 800.0,
        };

        assert_eq!(
            agent_surface_bounds(display, 480.0, 220.0, OverlayPlacement::UnderNotch),
            ScreenRect {
                x: 460.0,
                y: 64.0,
                width: 480.0,
                height: 220.0,
            }
        );
        assert_eq!(
            agent_surface_bounds(display, 480.0, 220.0, OverlayPlacement::LeftOfNotch).x,
            208.0
        );
        assert_eq!(
            agent_surface_bounds(display, 480.0, 220.0, OverlayPlacement::RightOfNotch).x,
            712.0
        );
        assert_eq!(
            agent_surface_bounds(display, 2000.0, 1000.0, OverlayPlacement::UnderNotch),
            ScreenRect {
                x: 100.0,
                y: 20.0,
                width: 1200.0,
                height: 800.0,
            }
        );
    }

    #[test]
    fn accessibility_material_preferences_are_opaque() {
        for preferences in [
            SurfacePreferences {
                reduce_transparency: true,
                increase_contrast: false,
            },
            SurfacePreferences {
                reduce_transparency: false,
                increase_contrast: true,
            },
        ] {
            assert_eq!(
                SurfaceTokens::for_preferences(preferences).background.a,
                1.0
            );
        }
    }

    #[test]
    fn state_transitions_reject_invalid_completion_and_reentry() {
        assert_eq!(
            AgentSurfaceState::Ready.transition(AgentSurfaceEvent::Saved),
            AgentSurfaceState::Ready
        );
        assert_eq!(
            AgentSurfaceState::Ready
                .transition(AgentSurfaceEvent::Analyze)
                .transition(AgentSurfaceEvent::Analyze)
                .transition(AgentSurfaceEvent::Cancel),
            AgentSurfaceState::Ready
        );
    }

    #[gpui::test]
    fn agent_state_actions_are_guarded(cx: &mut TestAppContext) {
        let window = cx.add_window(|window, cx| {
            AgentSurfaceView::new(SurfacePreferences::default(), window, cx)
        });
        cx.dispatch_action(window.into(), Analyze);
        assert_eq!(
            window.read_with(cx, |view, _| view.state()).unwrap(),
            AgentSurfaceState::Analyzing
        );
        cx.dispatch_action(window.into(), Analyze);
        assert_eq!(
            window.read_with(cx, |view, _| view.state()).unwrap(),
            AgentSurfaceState::Analyzing
        );
    }
}
