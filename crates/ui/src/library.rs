use crate::{
    ActivateFocused, FocusNext, FocusPrevious, NewThread, SaveToKnowledgeBase, ShowKnowledgeBase,
    ShowThreads,
};
use emma_core::{
    AppPreferences, KnowledgePage, LiveClient, LiveSnapshot, OverlayPlacement, PageId, Thread,
    ThreadId, ThreadRole,
};
use gpui::{
    AppContext as _, Context, FocusHandle, Focusable, FontWeight, MouseButton, Render, Role,
    Subscription, Task, Window, div, prelude::*, px, rgb,
};
use gpui_base::input::{Input, InputBase, InputEvent, InputState};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Destination {
    #[default]
    Threads,
    Knowledge,
}

pub struct LibraryView {
    live: LiveClient,
    threads: Vec<Thread>,
    pages: Vec<KnowledgePage>,
    selected_thread: Option<ThreadId>,
    selected_page: Option<PageId>,
    prompt: gpui::Entity<InputState>,
    root_focus: FocusHandle,
    new_focus: FocusHandle,
    threads_focus: FocusHandle,
    knowledge_focus: FocusHandle,
    send_focus: FocusHandle,
    save_focus: FocusHandle,
    destination: Destination,
    status: String,
    busy: bool,
    preferences: AppPreferences,
    _subscriptions: Vec<Subscription>,
    task: Option<Task<()>>,
}

impl LibraryView {
    pub fn new(live: LiveClient, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let threads_focus = cx.focus_handle();
        threads_focus.focus(window, cx);
        let prompt = cx.new(|cx| {
            InputState::new(window, cx)
                .placeholder("Ask Emma…")
                .submit_on_enter(true)
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
        let mut view = Self {
            live,
            threads: Vec::new(),
            pages: Vec::new(),
            selected_thread: None,
            selected_page: None,
            prompt,
            root_focus: cx.focus_handle(),
            new_focus: cx.focus_handle(),
            threads_focus,
            knowledge_focus: cx.focus_handle(),
            send_focus: cx.focus_handle(),
            save_focus: cx.focus_handle(),
            destination: Destination::Threads,
            status: "Loading durable library…".into(),
            busy: true,
            preferences: AppPreferences::default(),
            _subscriptions: vec![subscription],
            task: None,
        };
        view.load(cx);
        view
    }

    fn load(&mut self, cx: &mut Context<Self>) {
        let live = self.live.clone();
        let background = cx.background_spawn(async move { live.snapshot() });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(snapshot) => {
                        let warning = snapshot.warnings.first().cloned();
                        this.replace_snapshot(snapshot);
                        this.status = warning.unwrap_or_else(|| "Ready".into());
                    }
                    Err(error) => this.status = format!("Load failed: {error}"),
                }
                cx.notify();
            });
        }));
    }

    fn replace_snapshot(&mut self, snapshot: LiveSnapshot) {
        self.threads = snapshot.threads;
        self.pages = snapshot.pages;
        if !self
            .selected_thread
            .as_ref()
            .is_some_and(|id| self.threads.iter().any(|thread| &thread.id == id))
        {
            self.selected_thread = self.threads.first().map(|thread| thread.id.clone());
        }
        if !self
            .selected_page
            .as_ref()
            .is_some_and(|id| self.pages.iter().any(|page| &page.id == id))
        {
            self.selected_page = self.pages.first().map(|page| page.id.clone());
        }
    }

    fn new_thread(&mut self, _: &NewThread, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.destination = Destination::Threads;
        self.busy = true;
        self.status = "Creating thread…".into();
        self.prompt.update(cx, |input, cx| input.focus(window, cx));
        let live = self.live.clone();
        let background = cx.background_spawn(async move { live.create_thread() });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(thread) => {
                        this.selected_thread = Some(thread.id.clone());
                        this.threads.insert(0, thread);
                        this.status = "New thread ready".into();
                    }
                    Err(error) => this.status = format!("Create failed: {error}"),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn show_threads(&mut self, _: &ShowThreads, _: &mut Window, cx: &mut Context<Self>) {
        self.destination = Destination::Threads;
        self.status = "Threads".into();
        cx.notify();
    }

    fn show_knowledge(&mut self, _: &ShowKnowledgeBase, _: &mut Window, cx: &mut Context<Self>) {
        self.destination = Destination::Knowledge;
        self.status = "Knowledge Base".into();
        cx.notify();
    }

    fn submit(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(thread_id) = self.selected_thread.clone() else {
            self.status = "Create or select a thread first".into();
            cx.notify();
            return;
        };
        let content = self.prompt.read(cx).value().trim().to_string();
        if content.is_empty() {
            return;
        }
        self.prompt
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.busy = true;
        self.status = "Emma is responding…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move {
            let result = live.send_message(thread_id, content);
            let snapshot = result.as_ref().err().and_then(|_| live.snapshot().ok());
            (result, snapshot)
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let (result, snapshot) = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(thread) => {
                        this.threads.retain(|item| item.id != thread.id);
                        this.selected_thread = Some(thread.id.clone());
                        this.threads.insert(0, thread);
                        this.status = "Response saved".into();
                    }
                    Err(error) => {
                        if let Some(snapshot) = snapshot {
                            this.replace_snapshot(snapshot);
                        }
                        this.status = format!("Send failed: {error}");
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn save(&mut self, _: &SaveToKnowledgeBase, _: &mut Window, cx: &mut Context<Self>) {
        if self.busy || !self.can_save() {
            return;
        }
        let Some(thread_id) = self.selected_thread.clone() else {
            return;
        };
        self.busy = true;
        self.status = "Analyzing and saving…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move { live.save_to_knowledge(thread_id) });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(page) => {
                        this.pages.retain(|item| item.id != page.id);
                        this.selected_page = Some(page.id.clone());
                        this.pages.insert(0, page);
                        this.destination = Destination::Knowledge;
                        this.status = "Analysis saved to Knowledge Base".into();
                    }
                    Err(error) => this.status = format!("Save failed: {error}"),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn selected_thread(&self) -> Option<&Thread> {
        let id = self.selected_thread.as_ref()?;
        self.threads.iter().find(|thread| &thread.id == id)
    }

    fn selected_page(&self) -> Option<&KnowledgePage> {
        let id = self.selected_page.as_ref()?;
        self.pages.iter().find(|page| &page.id == id)
    }

    fn can_save(&self) -> bool {
        self.selected_thread().is_some_and(|thread| {
            thread
                .messages
                .iter()
                .any(|message| message.role == ThreadRole::Assistant)
        })
    }

    fn activate(&mut self, _: &ActivateFocused, window: &mut Window, cx: &mut Context<Self>) {
        if self.new_focus.is_focused(window) {
            self.new_thread(&NewThread, window, cx);
        } else if self.threads_focus.is_focused(window) {
            self.show_threads(&ShowThreads, window, cx);
        } else if self.knowledge_focus.is_focused(window) {
            self.show_knowledge(&ShowKnowledgeBase, window, cx);
        } else if self.send_focus.is_focused(window) {
            self.submit(window, cx);
        } else if self.save_focus.is_focused(window) {
            self.save(&SaveToKnowledgeBase, window, cx);
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
        let is_threads = self.destination == Destination::Threads;
        let selected_thread = self.selected_thread().cloned();
        let selected_page = self.selected_page().cloned();
        let can_send = !self.busy && selected_thread.is_some();
        let can_save = !self.busy && self.can_save();
        let placement = match self.preferences.overlay_placement {
            OverlayPlacement::LeftOfNotch => "left of center",
            OverlayPlacement::RightOfNotch => "right of center",
            OverlayPlacement::UnderNotch => "under center",
        };

        let list = div()
            .w(px(230.0))
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
                    .font_weight(FontWeight::SEMIBOLD)
                    .child(if is_threads { "Threads" } else { "Pages" }),
            );
        let list = if is_threads {
            list.when(self.threads.is_empty(), |list| {
                list.child(
                    div()
                        .text_size(px(12.0))
                        .text_color(rgb(0x7f8792))
                        .child("No threads yet."),
                )
            })
            .children(self.threads.iter().enumerate().map(|(index, thread)| {
                let id = thread.id.clone();
                let selected = self.selected_thread.as_ref() == Some(&id);
                div()
                    .id(("thread-row", index))
                    .accessibility_id(format!("emma.thread.{}", id.as_str()))
                    .role(Role::Button)
                    .aria_label(format!("{}, updated {}", thread.title, thread.updated_at))
                    .rounded(px(7.0))
                    .p(px(9.0))
                    .when(selected, |row| row.bg(rgb(0x292d33)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_thread = Some(id.clone());
                        this.status = "Thread selected".into();
                        cx.notify();
                    }))
                    .child(div().text_size(px(13.0)).child(thread.title.clone()))
                    .child(
                        div()
                            .mt(px(3.0))
                            .text_size(px(11.0))
                            .text_color(rgb(0x7f8792))
                            .child(format!("{} messages", thread.messages.len())),
                    )
            }))
        } else {
            list.when(self.pages.is_empty(), |list| {
                list.child(
                    div()
                        .text_size(px(12.0))
                        .text_color(rgb(0x7f8792))
                        .child("Nothing saved yet."),
                )
            })
            .children(self.pages.iter().enumerate().map(|(index, page)| {
                let id = page.id.clone();
                let selected = self.selected_page.as_ref() == Some(&id);
                div()
                    .id(("page-row", index))
                    .accessibility_id(format!("emma.page.{}", id.as_str()))
                    .role(Role::Button)
                    .aria_label(format!("{}, {}", page.title, page.category.as_str()))
                    .rounded(px(7.0))
                    .p(px(9.0))
                    .when(selected, |row| row.bg(rgb(0x292d33)))
                    .cursor_pointer()
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.selected_page = Some(id.clone());
                        this.status = "Knowledge page selected".into();
                        cx.notify();
                    }))
                    .child(div().text_size(px(13.0)).child(page.title.clone()))
                    .child(
                        div()
                            .mt(px(3.0))
                            .text_size(px(11.0))
                            .text_color(rgb(0x7f8792))
                            .child(page.category.as_str().to_owned()),
                    )
            }))
        };

        let content = div()
            .id("library-content-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(10.0));
        let content = if is_threads {
            if let Some(thread) = &selected_thread {
                content
                    .children(thread.messages.iter().enumerate().map(|(index, message)| {
                        let assistant = message.role == ThreadRole::Assistant;
                        div()
                            .id(("message", index))
                            .role(Role::Group)
                            .aria_label(if assistant {
                                "Assistant message"
                            } else {
                                "User message"
                            })
                            .max_w(px(680.0))
                            .when(!assistant, |bubble| bubble.self_end())
                            .rounded(px(10.0))
                            .border_1()
                            .border_color(rgb(0x292e35))
                            .bg(if assistant {
                                rgb(0x15191e)
                            } else {
                                rgb(0x233750)
                            })
                            .p(px(14.0))
                            .text_size(px(14.0))
                            .line_height(px(22.0))
                            .child(message.content.clone())
                    }))
                    .when(thread.messages.is_empty(), |content| {
                        content.child("This durable thread is ready for a prompt.")
                    })
            } else {
                content.child("Create a durable thread to start.")
            }
        } else if let Some(page) = &selected_page {
            content
                .child(
                    div()
                        .max_w(px(680.0))
                        .rounded(px(10.0))
                        .border_1()
                        .border_color(rgb(0x292e35))
                        .bg(rgb(0x15191e))
                        .p(px(18.0))
                        .child(page.analysis.summary.clone()),
                )
                .child(
                    div()
                        .max_w(px(680.0))
                        .text_size(px(14.0))
                        .line_height(px(22.0))
                        .child(page.analysis.body.clone()),
                )
                .child(
                    div()
                        .text_size(px(12.0))
                        .text_color(rgb(0x7f8792))
                        .child(format!(
                            "Saved {} · {} · {} sources",
                            page.added_at,
                            page.telemetry.model,
                            page.sources.len()
                        )),
                )
        } else {
            content.child("Knowledge pages appear only after Save & Analyze.")
        };

        let prompt = self.prompt.clone();
        let prompt_for_mouse = prompt.clone();
        let prompt_focused = prompt.read(cx).focus_handle(cx).is_focused(window);
        let title = if is_threads {
            selected_thread
                .as_ref()
                .map_or("Threads", |thread| thread.title.as_str())
        } else {
            selected_page
                .as_ref()
                .map_or("Knowledge Base", |page| page.title.as_str())
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
            .on_action(cx.listener(Self::show_knowledge))
            .on_action(cx.listener(Self::save))
            .on_action(cx.listener(Self::activate))
            .on_action(cx.listener(Self::focus_next))
            .on_action(cx.listener(Self::focus_previous))
            .size_full()
            .flex()
            .bg(rgb(0x0d0f12))
            .text_color(rgb(0xf4f5f7))
            .child(
                div()
                    .w(px(174.0))
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
                            .key_context("LibraryButton")
                            .focusable()
                            .tab_stop(!self.busy)
                            .track_focus(&self.new_focus)
                            .focus_visible(|style| style.border_2().border_color(rgb(0x8fc7ff)))
                            .role(Role::Button)
                            .aria_label("New thread")
                            .rounded(px(7.0))
                            .p(px(9.0))
                            .bg(rgb(0x24282e))
                            .when(!self.busy, |button| button.cursor_pointer())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_focus.focus(window, cx);
                                this.new_thread(&NewThread, window, cx);
                            }))
                            .child("＋  New Thread"),
                    )
                    .child(
                        nav_button("threads", "Threads", is_threads, &self.threads_focus).on_click(
                            cx.listener(|this, _, window, cx| {
                                this.threads_focus.focus(window, cx);
                                this.show_threads(&ShowThreads, window, cx);
                            }),
                        ),
                    )
                    .child(
                        nav_button(
                            "knowledge",
                            "Knowledge Base",
                            !is_threads,
                            &self.knowledge_focus,
                        )
                        .on_click(cx.listener(|this, _, window, cx| {
                            this.knowledge_focus.focus(window, cx);
                            this.show_knowledge(&ShowKnowledgeBase, window, cx);
                        })),
                    )
                    .child(
                        div()
                            .mt_auto()
                            .text_size(px(11.0))
                            .text_color(rgb(0x737b87))
                            .child("Screen capture is off by default."),
                    )
                    .child(
                        div()
                            .text_size(px(11.0))
                            .text_color(rgb(0x737b87))
                            .child(format!("Surface: {placement}")),
                    ),
            )
            .child(list)
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
                    .p(px(24.0))
                    .gap(px(14.0))
                    .child(
                        div()
                            .text_size(px(22.0))
                            .font_weight(FontWeight::SEMIBOLD)
                            .child(title.to_owned()),
                    )
                    .child(
                        div()
                            .id("library-status")
                            .role(Role::Status)
                            .aria_label(self.status.clone())
                            .text_size(px(12.0))
                            .text_color(rgb(0x7f8792))
                            .child(self.status.clone()),
                    )
                    .child(content)
                    .when(is_threads, |main| {
                        main.child(
                            div()
                                .flex()
                                .items_center()
                                .gap(px(8.0))
                                .child(
                                    InputBase::new("thread-prompt")
                                        .accessibility_label("Thread prompt")
                                        .focused(prompt_focused)
                                        .disabled(!can_send)
                                        .flex_1()
                                        .h(px(42.0))
                                        .px(px(12.0))
                                        .flex()
                                        .items_center()
                                        .rounded(px(8.0))
                                        .border_1()
                                        .border_color(rgb(0x3a414b))
                                        .bg(rgb(0x15191e))
                                        .styles(|styles| {
                                            styles
                                                .focused(|style| style.border_color(rgb(0x8fc7ff)))
                                        })
                                        .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                                            prompt_for_mouse
                                                .update(cx, |input, cx| input.focus(window, cx));
                                        })
                                        .child(Input::new(&prompt)),
                                )
                                .child(
                                    action_button(
                                        "send-message",
                                        "Send",
                                        can_send,
                                        &self.send_focus,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            this.send_focus.focus(window, cx);
                                            this.submit(window, cx);
                                        },
                                    )),
                                )
                                .child(
                                    action_button(
                                        "save-analysis",
                                        "Save & Analyze",
                                        can_save,
                                        &self.save_focus,
                                    )
                                    .on_click(cx.listener(
                                        |this, _, window, cx| {
                                            this.save_focus.focus(window, cx);
                                            this.save(&SaveToKnowledgeBase, window, cx);
                                        },
                                    )),
                                ),
                        )
                    }),
            )
    }
}

fn nav_button(
    id: &'static str,
    label: &'static str,
    selected: bool,
    focus: &FocusHandle,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .key_context("LibraryButton")
        .focusable()
        .tab_stop(true)
        .track_focus(focus)
        .focus_visible(|style| style.border_2().border_color(rgb(0x8fc7ff)))
        .role(Role::Button)
        .aria_label(label)
        .rounded(px(7.0))
        .p(px(9.0))
        .when(selected, |button| button.bg(rgb(0x30343a)))
        .cursor_pointer()
        .child(label)
}

fn action_button(
    id: &'static str,
    label: &'static str,
    enabled: bool,
    focus: &FocusHandle,
) -> gpui::Stateful<gpui::Div> {
    div()
        .id(id)
        .key_context("LibraryButton")
        .focusable()
        .tab_stop(enabled)
        .track_focus(focus)
        .focus_visible(|style| style.border_2().border_color(rgb(0xffffff)))
        .role(Role::Button)
        .aria_label(if enabled {
            label.to_owned()
        } else {
            format!("{label}, unavailable")
        })
        .rounded(px(8.0))
        .bg(if enabled {
            rgb(0x2f80ed)
        } else {
            rgb(0x2b3440)
        })
        .px(px(14.0))
        .py(px(10.0))
        .when(enabled, |button| button.cursor_pointer())
        .child(label)
}
