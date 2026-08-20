use crate::{
    ActivateFocused, AnalyzeKnowledgePage, FocusNext, FocusPrevious, NewThread,
    SaveToKnowledgeBase, ShowKnowledgeBase, ShowThreads,
};
use emma_core::{AppPreferences, OverlayPlacement};
use gpui::{Context, FocusHandle, FontWeight, Render, Role, Window, div, prelude::*, px, rgb};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum LibraryDestination {
    #[default]
    Threads,
    KnowledgeBase,
}

pub struct LibraryView {
    root_focus: FocusHandle,
    new_thread_focus: FocusHandle,
    threads_focus: FocusHandle,
    knowledge_focus: FocusHandle,
    primary_action_focus: FocusHandle,
    destination: LibraryDestination,
    activity: &'static str,
    preferences: AppPreferences,
}

impl LibraryView {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let threads_focus = cx.focus_handle();
        threads_focus.focus(window, cx);
        Self {
            root_focus: cx.focus_handle(),
            new_thread_focus: cx.focus_handle(),
            threads_focus,
            knowledge_focus: cx.focus_handle(),
            primary_action_focus: cx.focus_handle(),
            destination: LibraryDestination::Threads,
            activity: "Ready",
            preferences: AppPreferences::default(),
        }
    }

    fn new_thread(&mut self, _: &NewThread, _: &mut Window, cx: &mut Context<Self>) {
        self.destination = LibraryDestination::Threads;
        self.activity = "New thread ready";
        cx.notify();
    }

    fn show_threads(&mut self, _: &ShowThreads, _: &mut Window, cx: &mut Context<Self>) {
        self.destination = LibraryDestination::Threads;
        self.activity = "Threads";
        cx.notify();
    }

    fn show_knowledge_base(
        &mut self,
        _: &ShowKnowledgeBase,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.destination = LibraryDestination::KnowledgeBase;
        self.activity = "Knowledge Base";
        cx.notify();
    }

    fn save_to_knowledge_base(
        &mut self,
        _: &SaveToKnowledgeBase,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.activity = "Saved fixture page to Knowledge Base";
        cx.notify();
    }

    fn analyze_knowledge_page(
        &mut self,
        _: &AnalyzeKnowledgePage,
        _: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.activity = "Analyzed fixture knowledge page";
        cx.notify();
    }

    fn activate_focused(
        &mut self,
        _: &ActivateFocused,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.new_thread_focus.is_focused(window) {
            self.new_thread(&NewThread, window, cx);
        } else if self.threads_focus.is_focused(window) {
            self.show_threads(&ShowThreads, window, cx);
        } else if self.knowledge_focus.is_focused(window) {
            self.show_knowledge_base(&ShowKnowledgeBase, window, cx);
        } else if self.primary_action_focus.is_focused(window) {
            match self.destination {
                LibraryDestination::Threads => {
                    self.save_to_knowledge_base(&SaveToKnowledgeBase, window, cx)
                }
                LibraryDestination::KnowledgeBase => {
                    self.analyze_knowledge_page(&AnalyzeKnowledgePage, window, cx)
                }
            }
        }
    }

    fn focus_next(&mut self, _: &FocusNext, window: &mut Window, cx: &mut Context<Self>) {
        window.focus_next(cx);
    }

    fn focus_previous(&mut self, _: &FocusPrevious, window: &mut Window, cx: &mut Context<Self>) {
        window.focus_prev(cx);
    }
}

impl Render for LibraryView {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let placement = match self.preferences.overlay_placement {
            OverlayPlacement::LeftOfNotch => "Left of display center",
            OverlayPlacement::RightOfNotch => "Right of display center",
            OverlayPlacement::UnderNotch => "Under display center",
        };
        let is_threads = self.destination == LibraryDestination::Threads;
        let show_list = window.viewport_size().width >= px(760.0);
        let show_inspector = window.viewport_size().width >= px(1180.0);
        let items: &[(&str, &str)] = if is_threads {
            &[
                ("Prepare project brief", "Today"),
                ("Compare research notes", "Yesterday"),
                ("Summarize launch plan", "Monday"),
            ]
        } else {
            &[
                ("Product principles", "3 sources"),
                ("Launch checklist", "2 sources"),
                ("Research digest", "5 sources"),
            ]
        };

        div()
            .id("emma-library")
            .accessibility_id("emma.library")
            .role(Role::Application)
            .aria_label("Emma desktop")
            .key_context("LibraryShell")
            .track_focus(&self.root_focus)
            .on_action(cx.listener(Self::new_thread))
            .on_action(cx.listener(Self::show_threads))
            .on_action(cx.listener(Self::show_knowledge_base))
            .on_action(cx.listener(Self::save_to_knowledge_base))
            .on_action(cx.listener(Self::analyze_knowledge_page))
            .on_action(cx.listener(Self::activate_focused))
            .on_action(cx.listener(Self::focus_next))
            .on_action(cx.listener(Self::focus_previous))
            .size_full()
            .flex()
            .bg(rgb(0x0d0f12))
            .text_color(rgb(0xf4f5f7))
            .child(
                div()
                    .w(px(190.0))
                    .h_full()
                    .flex()
                    .flex_col()
                    .gap(px(8.0))
                    .p(px(14.0))
                    .border_r_1()
                    .border_color(rgb(0x252a31))
                    .bg(rgb(0x14171b))
                    .child(
                        div()
                            .mb(px(12.0))
                            .text_size(px(19.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child("Emma"),
                    )
                    .child(
                        div()
                            .id("new-thread")
                            .accessibility_id("emma.library.new-thread")
                            .focusable()
                            .tab_stop(true)
                            .track_focus(&self.new_thread_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0x8fc7ff)))
                            .role(Role::Button)
                            .aria_label("New thread")
                            .rounded(px(7.0))
                            .px(px(10.0))
                            .py(px(8.0))
                            .bg(rgb(0x24282e))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_thread_focus.focus(window, cx);
                                this.new_thread(&NewThread, window, cx);
                            }))
                            .child("＋  New Thread"),
                    )
                    .child(
                        div()
                            .id("threads-destination")
                            .accessibility_id("emma.library.threads")
                            .focusable()
                            .tab_stop(true)
                            .track_focus(&self.threads_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0x8fc7ff)))
                            .role(Role::Button)
                            .aria_label("Threads")
                            .rounded(px(7.0))
                            .px(px(10.0))
                            .py(px(8.0))
                            .when(is_threads, |item| item.bg(rgb(0x30343a)))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.threads_focus.focus(window, cx);
                                this.show_threads(&ShowThreads, window, cx);
                            }))
                            .child("Threads"),
                    )
                    .child(
                        div()
                            .id("knowledge-destination")
                            .accessibility_id("emma.library.knowledge-base")
                            .focusable()
                            .tab_stop(true)
                            .track_focus(&self.knowledge_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0x8fc7ff)))
                            .role(Role::Button)
                            .aria_label("Knowledge Base")
                            .rounded(px(7.0))
                            .px(px(10.0))
                            .py(px(8.0))
                            .when(!is_threads, |item| item.bg(rgb(0x30343a)))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.knowledge_focus.focus(window, cx);
                                this.show_knowledge_base(&ShowKnowledgeBase, window, cx);
                            }))
                            .child("Knowledge Base"),
                    )
                    .child(
                        div()
                            .mt(px(14.0))
                            .text_size(px(13.0))
                            .text_color(rgb(0x7f8792))
                            .child("Scheduled"),
                    )
                    .child(
                        div()
                            .text_size(px(13.0))
                            .text_color(rgb(0x7f8792))
                            .child("Plugins"),
                    )
                    .child(
                        div()
                            .mt_auto()
                            .text_size(px(12.0))
                            .text_color(rgb(0x737b87))
                            .child(format!("Agent: {placement}")),
                    ),
            )
            .when(show_list, |shell| {
                shell.child(
                    div()
                        .w(px(244.0))
                        .h_full()
                        .flex()
                        .flex_col()
                        .gap(px(8.0))
                        .p(px(14.0))
                        .border_r_1()
                        .border_color(rgb(0x252a31))
                        .bg(rgb(0x111419))
                        .child(
                            div()
                                .mb(px(6.0))
                                .font_weight(FontWeight::SEMIBOLD)
                                .child(if is_threads { "Threads" } else { "Pages" }),
                        )
                        .children(items.iter().enumerate().map(|(index, (title, meta))| {
                            div()
                                .id(("library-list-item", index))
                                .role(Role::ListItem)
                                .aria_label(format!("{title}, {meta}"))
                                .rounded(px(7.0))
                                .p(px(9.0))
                                .when(index == 0, |item| item.bg(rgb(0x292d33)))
                                .child(div().text_size(px(13.0)).child(*title))
                                .child(
                                    div()
                                        .mt(px(3.0))
                                        .text_size(px(11.0))
                                        .text_color(rgb(0x7f8792))
                                        .child(*meta),
                                )
                        })),
                )
            })
            .child(
                div()
                    .id("library-main")
                    .role(Role::Main)
                    .aria_label(if is_threads {
                        "Selected thread"
                    } else {
                        "Selected knowledge page"
                    })
                    .flex_1()
                    .min_w_0()
                    .h_full()
                    .flex()
                    .flex_col()
                    .p(px(28.0))
                    .gap(px(18.0))
                    .child(
                        div()
                            .flex()
                            .flex_col()
                            .gap(px(6.0))
                            .child(
                                div()
                                    .text_size(px(22.0))
                                    .font_weight(FontWeight::SEMIBOLD)
                                    .child(if is_threads {
                                        "Prepare project brief"
                                    } else {
                                        "Product principles"
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(12.0))
                                    .text_color(rgb(0x7f8792))
                                    .child(self.activity),
                            ),
                    )
                    .child(
                        div()
                            .max_w(px(680.0))
                            .rounded(px(10.0))
                            .border_1()
                            .border_color(rgb(0x292e35))
                            .bg(rgb(0x15191e))
                            .p(px(18.0))
                            .text_size(px(14.0))
                            .line_height(px(22.0))
                            .child(if is_threads {
                                "Emma keeps ordinary work in threads. This fixture transcript summarizes the goal, decisions, and next action without treating every conversation as a knowledge record."
                            } else {
                                "Knowledge pages are deliberate, durable records. This fixture page keeps a concise principle, linked sources, and the analysis that justified saving it."
                            }),
                    )
                    .child(
                        div()
                            .id("library-primary-action")
                            .accessibility_id("emma.library.primary-action")
                            .focusable()
                            .tab_stop(true)
                            .track_focus(&self.primary_action_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0xffffff)))
                            .role(Role::Button)
                            .aria_label(if is_threads {
                                "Save selected thread page to Knowledge Base"
                            } else {
                                "Analyze selected knowledge page"
                            })
                            .self_start()
                            .rounded(px(8.0))
                            .bg(rgb(0x2f80ed))
                            .px(px(14.0))
                            .py(px(8.0))
                            .cursor_pointer()
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.primary_action_focus.focus(window, cx);
                                match this.destination {
                                    LibraryDestination::Threads => this.save_to_knowledge_base(
                                        &SaveToKnowledgeBase,
                                        window,
                                        cx,
                                    ),
                                    LibraryDestination::KnowledgeBase => this
                                        .analyze_knowledge_page(&AnalyzeKnowledgePage, window, cx),
                                }
                            }))
                            .child(if is_threads {
                                "Save to Knowledge Base"
                            } else {
                                "Analyze page"
                            }),
                    ),
            )
            .when(show_inspector, |shell| {
                shell.child(
                    div()
                        .id("library-inspector")
                        .role(Role::Complementary)
                        .aria_label("Sources and run metadata")
                        .w(px(238.0))
                        .h_full()
                        .flex()
                        .flex_col()
                        .gap(px(12.0))
                        .p(px(16.0))
                        .border_l_1()
                        .border_color(rgb(0x252a31))
                        .bg(rgb(0x111419))
                        .child(
                            div()
                                .font_weight(FontWeight::SEMIBOLD)
                                .child("Details"),
                        )
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(rgb(0x9aa2ad))
                                .child(if is_threads {
                                    "Run · Fixture context\nStatus · Ready\nSources · 1"
                                } else {
                                    "Saved · Today\nSources · 3\nAnalysis · Current"
                                }),
                        ),
                )
            })
    }
}
