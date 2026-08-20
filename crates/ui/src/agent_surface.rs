use crate::{
    ActivateFocused, Analyze, DismissAgentSurface, FocusNext, FocusPrevious, ToggleAgentSurface,
};
use emma_core::{LiveClient, OverlayPlacement, Thread, ThreadRole};
use gpui::{
    AppContext as _, Context, FocusHandle, Focusable, FontWeight, MouseButton, Render, Role,
    Subscription, Task, Window, div, prelude::*, px, rgb, rgba,
};
use gpui_base::{
    Button,
    input::{Input, InputBase, InputEditorStyle, InputEvent, InputState},
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
    fn transition(self, event: AgentSurfaceEvent) -> Self {
        match (self, event) {
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
                background: rgba(0x080808ff),
                panel: rgba(0x101010ff),
                border: rgba(0xffffffff),
                secondary: rgba(0xd8d8d8ff),
            }
        } else if preferences.reduce_transparency {
            Self {
                background: rgba(0x080808ff),
                panel: rgba(0x191919ff),
                border: rgba(0x3a3a3aff),
                secondary: rgba(0x9c9c9cff),
            }
        } else {
            Self {
                background: rgba(0x080808f0),
                panel: rgba(0x191919e8),
                border: rgba(0xffffff20),
                secondary: rgba(0x9c9c9cff),
            }
        }
    }
}

pub struct AgentSurfaceView {
    live: LiveClient,
    thread: Option<Thread>,
    prompt: gpui::Entity<InputState>,
    state: AgentSurfaceState,
    status: String,
    root_focus: FocusHandle,
    send_focus: FocusHandle,
    preferences: SurfacePreferences,
    _subscriptions: Vec<Subscription>,
    task: Option<Task<()>>,
}

impl AgentSurfaceView {
    pub fn new(
        live: LiveClient,
        preferences: SurfacePreferences,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) -> Self {
        let prompt = cx.new(|cx| {
            let mut state = InputState::new(window, cx)
                .placeholder("Ask Emma…")
                .submit_on_enter(true);
            state.set_editor_style(InputEditorStyle {
                foreground: rgb(0xf3f3f3).into(),
                muted_foreground: rgb(0x9c9c9c).into(),
                selection: gpui::hsla(0.1, 0.11, 0.39, 0.55),
                caret: rgb(0xf3f3f3).into(),
                ..InputEditorStyle::default()
            });
            state
        });
        let subscription = cx.subscribe_in(
            &prompt,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { shift: false, .. }) {
                    this.submit(window, cx);
                }
            },
        );
        prompt.update(cx, |input, cx| input.focus(window, cx));
        let mut view = Self {
            live,
            thread: None,
            prompt,
            state: AgentSurfaceState::Analyzing,
            status: "Loading durable thread…".into(),
            root_focus: cx.focus_handle(),
            send_focus: cx.focus_handle(),
            preferences,
            _subscriptions: vec![subscription],
            task: None,
        };
        view.load(cx);
        view
    }

    pub fn state(&self) -> AgentSurfaceState {
        self.state
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        self.state = AgentSurfaceState::Analyzing;
        self.status = "Loading durable thread…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move {
            let snapshot = live.snapshot()?;
            match snapshot.threads.into_iter().next() {
                Some(thread) => Ok(thread),
                None => live.create_thread(),
            }
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                match result {
                    Ok(thread) => {
                        this.thread = Some(thread);
                        this.state = AgentSurfaceState::Ready;
                        this.status = "Ready".into();
                    }
                    Err(error) => {
                        this.state = AgentSurfaceState::Failed;
                        this.status = format!("Load failed: {error}");
                    }
                }
                cx.notify();
            });
        }));
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.state == AgentSurfaceState::Analyzing {
            return;
        }
        let Some(thread_id) = self.thread.as_ref().map(|thread| thread.id.clone()) else {
            self.load(cx);
            return;
        };
        let content = self.prompt.read(cx).value().trim().to_string();
        if content.is_empty() {
            return;
        }
        self.prompt
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.state = self.state.transition(AgentSurfaceEvent::Analyze);
        self.status = "Emma is responding…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move {
            let result = live.send_message(thread_id, content);
            let restored = result
                .as_ref()
                .err()
                .and_then(|_| live.snapshot().ok())
                .and_then(|snapshot| snapshot.threads.into_iter().next());
            (result, restored)
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let (result, restored) = background.await;
            let _ = view.update(cx, |this, cx| {
                match result {
                    Ok(thread) => {
                        this.thread = Some(thread);
                        this.state = this.state.transition(AgentSurfaceEvent::Saved);
                        this.status = "Response saved".into();
                    }
                    Err(error) => {
                        if let Some(thread) = restored {
                            this.thread = Some(thread);
                        }
                        this.state = this.state.transition(AgentSurfaceEvent::Failed);
                        this.status = format!("Send failed: {error}");
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn analyze(&mut self, _: &Analyze, window: &mut Window, cx: &mut Context<Self>) {
        self.submit(window, cx);
    }

    fn dismiss(&mut self, _: &DismissAgentSurface, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        window.remove_window();
    }

    fn toggle(&mut self, _: &ToggleAgentSurface, window: &mut Window, cx: &mut Context<Self>) {
        cx.stop_propagation();
        window.remove_window();
    }

    fn activate(&mut self, _: &ActivateFocused, window: &mut Window, cx: &mut Context<Self>) {
        if self.send_focus.is_focused(window) {
            self.submit(window, cx);
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let tokens = SurfaceTokens::for_preferences(self.preferences);
        let working = self.state == AgentSurfaceState::Analyzing;
        let latest = self
            .thread
            .as_ref()
            .and_then(|thread| {
                thread
                    .messages
                    .iter()
                    .rev()
                    .find(|message| message.role == ThreadRole::Assistant)
            })
            .map(|message| message.content.clone())
            .unwrap_or_else(|| "This durable thread is ready.".into());
        let thread_summary = self.thread.as_ref().map_or_else(
            || "Preparing a durable thread…".into(),
            |thread| format!("{} · {} messages", thread.title, thread.messages.len()),
        );
        let prompt = self.prompt.clone();
        let prompt_for_mouse = prompt.clone();
        let prompt_focused = prompt.read(cx).focus_handle(cx).is_focused(window);

        div()
            .id("agent-surface")
            .accessibility_id("emma.agent-surface")
            .key_context("AgentSurface")
            .role(Role::Dialog)
            .aria_label("Emma agent surface")
            .track_focus(&self.root_focus)
            .on_action(cx.listener(Self::analyze))
            .on_action(cx.listener(Self::dismiss))
            .on_action(cx.listener(Self::toggle))
            .on_action(cx.listener(Self::activate))
            .on_action(cx.listener(Self::focus_next))
            .on_action(cx.listener(Self::focus_previous))
            .size_full()
            .p(px(14.0))
            .bg(tokens.background)
            .text_color(rgb(0xf3f3f3))
            .flex()
            .flex_col()
            .gap(px(10.0))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(8.0))
                            .child(
                                div()
                                    .size(px(24.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(4.0))
                                    .border_1()
                                    .border_color(tokens.border)
                                    .text_color(rgb(0x6f6759))
                                    .child("◇"),
                            )
                            .child(
                                div()
                                    .font_family("Menlo")
                                    .text_size(px(10.0))
                                    .font_weight(FontWeight::MEDIUM)
                                    .child("EMMA"),
                            ),
                    )
                    .child(
                        div()
                            .id("agent-status")
                            .role(Role::Status)
                            .aria_label(self.status.clone())
                            .flex()
                            .items_center()
                            .gap(px(7.0))
                            .font_family("Menlo")
                            .text_size(px(9.0))
                            .child(div().size(px(5.0)).rounded_full().bg(if working {
                                rgb(0x6f6759)
                            } else {
                                rgb(0x98ff38)
                            }))
                            .child(self.status.clone()),
                    ),
            )
            .child(
                div()
                    .font_family("Menlo")
                    .text_size(px(9.0))
                    .text_color(tokens.secondary)
                    .child(thread_summary.to_uppercase()),
            )
            .child(
                div()
                    .id("latest-response")
                    .role(Role::Group)
                    .aria_label("Latest assistant response")
                    .flex_1()
                    .min_h_0()
                    .border_l_1()
                    .border_color(rgba(0x6f6759ff))
                    .pl(px(12.0))
                    .py(px(4.0))
                    .text_size(px(12.0))
                    .line_height(px(18.0))
                    .text_color(rgb(0xd0d0d0))
                    .child(latest),
            )
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(8.0))
                    .rounded(px(8.0))
                    .border_1()
                    .border_color(tokens.border)
                    .bg(tokens.panel)
                    .p(px(5.0))
                    .child(
                        InputBase::new("surface-prompt")
                            .accessibility_label("Agent prompt")
                            .focused(prompt_focused)
                            .disabled(working)
                            .flex_1()
                            .h(px(36.0))
                            .px(px(10.0))
                            .flex()
                            .items_center()
                            .rounded(px(4.0))
                            .bg(tokens.panel)
                            .text_color(tokens.secondary)
                            .styles(|styles| styles.focused(|style| style.bg(rgba(0xffffff0d))))
                            .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                prompt_for_mouse.update(cx, |input, cx| input.focus(window, cx));
                            })
                            .child(Input::new(&prompt)),
                    )
                    .child(
                        Button::new("send-agent-message")
                            .accessibility_id("emma.agent.send")
                            .key_context("AgentSurfaceButton")
                            .disabled(working)
                            .tab_stop(!working)
                            .track_focus(&self.send_focus)
                            .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
                            .accessibility_label(if working {
                                "Send message, unavailable"
                            } else {
                                "Send message"
                            })
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(if working {
                                rgb(0x2a2a2a)
                            } else {
                                rgb(0x444444)
                            })
                            .bg(if working {
                                rgb(0x202020)
                            } else {
                                rgb(0xf3f3f3)
                            })
                            .text_color(if working {
                                rgb(0x666666)
                            } else {
                                rgb(0x080808)
                            })
                            .font_family("Menlo")
                            .text_size(px(9.0))
                            .px(px(12.0))
                            .py(px(8.0))
                            .when(!working, |button| button.cursor_pointer())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.send_focus.focus(window, cx);
                                this.submit(window, cx);
                            }))
                            .child(if working { "Sending…" } else { "Send" }),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

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
                .transition(AgentSurfaceEvent::Saved),
            AgentSurfaceState::Saved
        );
    }
}
