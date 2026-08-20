use crate::{
    ActivateFocused, FocusNext, FocusPrevious, NewThread, SaveToKnowledgeBase, ShowKnowledgeBase,
    ShowThreads,
};
use emma_core::{
    AppPreferences, KnowledgeBase, KnowledgeBaseId, KnowledgePage, LiveClient, LiveSnapshot,
    OpenRouterModel, OverlayPlacement, PageId, Thread, ThreadId, ThreadRole,
};
use gpui::{
    AppContext as _, Context, FocusHandle, Focusable, FontWeight, MouseButton, Render, Role,
    Subscription, Task, Window, div, prelude::*, px, rgb,
};
use gpui_base::{
    Button,
    input::{Input, InputBase, InputEditorStyle, InputEvent, InputState},
};

const FREE_MODEL_PRIVACY_WARNING: &str = "Some routed providers may otherwise retain prompts or train on them. Emma requires data_collection: deny and ZDR; the request fails if no compliant endpoint exists. Your OpenRouter account logging/data-use settings still apply. Review openrouter.ai/settings/privacy.";

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum Destination {
    #[default]
    Threads,
    Knowledge,
}

pub struct LibraryView {
    live: LiveClient,
    threads: Vec<Thread>,
    knowledge_bases: Vec<KnowledgeBase>,
    pages: Vec<KnowledgePage>,
    selected_thread: Option<ThreadId>,
    selected_knowledge_base: KnowledgeBaseId,
    selected_page: Option<PageId>,
    prompt: gpui::Entity<InputState>,
    base_name: gpui::Entity<InputState>,
    root_focus: FocusHandle,
    new_focus: FocusHandle,
    threads_focus: FocusHandle,
    knowledge_focus: FocusHandle,
    send_focus: FocusHandle,
    save_focus: FocusHandle,
    create_base_focus: FocusHandle,
    load_models_focus: FocusHandle,
    destination: Destination,
    status: String,
    busy: bool,
    preferences: AppPreferences,
    openrouter_models: Vec<OpenRouterModel>,
    selected_openrouter_model: Option<String>,
    models_loaded: bool,
    _subscriptions: Vec<Subscription>,
    task: Option<Task<()>>,
}

impl LibraryView {
    pub fn new(live: LiveClient, window: &mut Window, cx: &mut Context<Self>) -> Self {
        let threads_focus = cx.focus_handle();
        threads_focus.focus(window, cx);
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
        let base_name = cx.new(|cx| {
            let mut state = InputState::new(window, cx)
                .placeholder("New base name…")
                .submit_on_enter(true);
            state.set_editor_style(InputEditorStyle {
                foreground: rgb(0xf3f3f3).into(),
                muted_foreground: rgb(0x777777).into(),
                selection: gpui::hsla(0.1, 0.11, 0.39, 0.55),
                caret: rgb(0xf3f3f3).into(),
                ..InputEditorStyle::default()
            });
            state
        });
        let base_subscription = cx.subscribe_in(
            &base_name,
            window,
            |this, _, event: &InputEvent, window, cx| {
                if matches!(event, InputEvent::PressEnter { shift: false, .. }) {
                    this.create_knowledge_base(window, cx);
                }
            },
        );
        let mut view = Self {
            live,
            threads: Vec::new(),
            knowledge_bases: vec![KnowledgeBase::default_base()],
            pages: Vec::new(),
            selected_thread: None,
            selected_knowledge_base: KnowledgeBaseId::default_id(),
            selected_page: None,
            prompt,
            base_name,
            root_focus: cx.focus_handle(),
            new_focus: cx.focus_handle(),
            threads_focus,
            knowledge_focus: cx.focus_handle(),
            send_focus: cx.focus_handle(),
            save_focus: cx.focus_handle(),
            create_base_focus: cx.focus_handle(),
            load_models_focus: cx.focus_handle(),
            destination: Destination::Threads,
            status: "Loading durable library…".into(),
            busy: true,
            preferences: AppPreferences::default(),
            openrouter_models: Vec::new(),
            selected_openrouter_model: None,
            models_loaded: false,
            _subscriptions: vec![subscription, base_subscription],
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
        let previous_thread = self.selected_thread.clone();
        self.threads = snapshot.threads;
        self.knowledge_bases = snapshot.knowledge_bases;
        self.pages = snapshot.pages;
        if !self
            .selected_thread
            .as_ref()
            .is_some_and(|id| self.threads.iter().any(|thread| &thread.id == id))
        {
            self.selected_thread = self.threads.first().map(|thread| thread.id.clone());
        }
        if self.selected_thread != previous_thread
            && let Some(thread_id) = self.selected_thread.clone()
        {
            self.select_thread_locally(thread_id);
        }
        if !self
            .knowledge_bases
            .iter()
            .any(|base| base.id == self.selected_knowledge_base)
        {
            self.selected_knowledge_base = KnowledgeBaseId::default_id();
        }
        if !self.selected_page.as_ref().is_some_and(|id| {
            self.pages.iter().any(|page| {
                &page.id == id && page.knowledge_base_id == self.selected_knowledge_base
            })
        }) {
            self.selected_page = self
                .pages
                .iter()
                .find(|page| page.knowledge_base_id == self.selected_knowledge_base)
                .map(|page| page.id.clone());
        }
    }

    fn select_thread_locally(&mut self, thread_id: ThreadId) {
        self.selected_thread = Some(thread_id.clone());
        let Some(base_id) = self
            .threads
            .iter()
            .find(|thread| thread.id == thread_id)
            .map(|thread| thread.knowledge_base_id.clone())
        else {
            return;
        };
        self.selected_knowledge_base = base_id;
        self.selected_page = self
            .pages
            .iter()
            .find(|page| page.knowledge_base_id == self.selected_knowledge_base)
            .map(|page| page.id.clone());
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
                        let thread_id = thread.id.clone();
                        this.threads.insert(0, thread);
                        this.select_thread_locally(thread_id);
                        this.status = "New thread ready".into();
                    }
                    Err(error) => this.status = format!("Create failed: {error}"),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn create_knowledge_base(&mut self, _: &mut Window, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(thread_id) = self.selected_thread.clone() else {
            self.status = "Create or select a thread first".into();
            cx.notify();
            return;
        };
        let name = self.base_name.read(cx).value().trim().to_owned();
        if name.is_empty() {
            self.status = "Enter a knowledge base name".into();
            cx.notify();
            return;
        }
        self.busy = true;
        self.status = "Creating knowledge base…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move {
            let result: Result<_, emma_core::LiveError> = (|| {
                let base = live.create_knowledge_base(name)?;
                let thread = live.select_thread_knowledge_base(thread_id, base.id.clone())?;
                Ok((base, thread))
            })();
            let snapshot = result.as_ref().err().and_then(|_| live.snapshot().ok());
            (result, snapshot)
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let (result, snapshot) = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok((base, thread)) => {
                        this.knowledge_bases.push(base.clone());
                        if let Some(existing) = this
                            .threads
                            .iter_mut()
                            .find(|existing| existing.id == thread.id)
                        {
                            *existing = thread;
                        }
                        this.selected_knowledge_base = base.id;
                        this.selected_page = None;
                        this.status = format!("Created and selected {}", base.name);
                    }
                    Err(error) => {
                        if let Some(snapshot) = snapshot {
                            this.replace_snapshot(snapshot);
                        }
                        this.status = format!("Create failed: {error}");
                    }
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn select_thread_knowledge_base(&mut self, base_id: KnowledgeBaseId, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        let Some(thread_id) = self.selected_thread.clone() else {
            return;
        };
        self.busy = true;
        self.status = "Selecting knowledge base…".into();
        let live = self.live.clone();
        let selected_id = base_id.clone();
        let background = cx.background_spawn(async move {
            live.select_thread_knowledge_base(thread_id, selected_id)
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(thread) => {
                        if let Some(existing) = this
                            .threads
                            .iter_mut()
                            .find(|existing| existing.id == thread.id)
                        {
                            *existing = thread;
                        }
                        this.selected_knowledge_base = base_id;
                        this.selected_page = this
                            .pages
                            .iter()
                            .find(|page| page.knowledge_base_id == this.selected_knowledge_base)
                            .map(|page| page.id.clone());
                        this.status = "Knowledge base selected".into();
                    }
                    Err(error) => this.status = format!("Selection failed: {error}"),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn select_knowledge_view_base(&mut self, base_id: KnowledgeBaseId, cx: &mut Context<Self>) {
        self.selected_knowledge_base = base_id;
        self.selected_page = self
            .pages
            .iter()
            .find(|page| page.knowledge_base_id == self.selected_knowledge_base)
            .map(|page| page.id.clone());
        self.status = "Knowledge base selected".into();
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
            let snapshot = live.snapshot().ok();
            (result, snapshot)
        });
        self.task = Some(cx.spawn(async move |view, cx| {
            let (result, snapshot) = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(thread) => {
                        this.selected_thread = Some(thread.id.clone());
                        if let Some(snapshot) = snapshot {
                            this.replace_snapshot(snapshot);
                        } else {
                            this.threads.retain(|item| item.id != thread.id);
                            this.threads.insert(0, thread);
                        }
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
                        this.selected_knowledge_base = page.knowledge_base_id.clone();
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

    fn load_openrouter_models(&mut self, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.status = "Loading privacy-filtered OpenRouter models…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move { live.list_openrouter_models() });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(catalog) => {
                        this.models_loaded = true;
                        this.openrouter_models = catalog.models;
                        this.selected_openrouter_model = catalog.selected_model;
                        this.status = format!(
                            "{} privacy-filtered free OpenRouter models",
                            this.openrouter_models.len()
                        );
                    }
                    Err(error) => this.status = format!("OpenRouter load failed: {error}"),
                }
                cx.notify();
            });
        }));
        cx.notify();
    }

    fn select_openrouter_model(&mut self, model_id: String, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        self.busy = true;
        self.status = "Selecting OpenRouter model…".into();
        let live = self.live.clone();
        let background = cx.background_spawn(async move { live.select_openrouter_model(model_id) });
        self.task = Some(cx.spawn(async move |view, cx| {
            let result = background.await;
            let _ = view.update(cx, |this, cx| {
                this.busy = false;
                match result {
                    Ok(model_id) => {
                        this.status = format!("Selected {model_id}");
                        this.selected_openrouter_model = Some(model_id);
                    }
                    Err(error) => this.status = format!("Model selection failed: {error}"),
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
        self.pages
            .iter()
            .find(|page| &page.id == id && page.knowledge_base_id == self.selected_knowledge_base)
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
        } else if self.create_base_focus.is_focused(window) {
            self.create_knowledge_base(window, cx);
        } else if self.load_models_focus.is_focused(window) {
            self.load_openrouter_models(cx);
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
        let selected_thread = self.selected_thread();
        let selected_page = self.selected_page();
        let selected_thread_base = selected_thread
            .as_ref()
            .map(|thread| thread.knowledge_base_id.clone());
        let visible_pages = self
            .pages
            .iter()
            .filter(|page| page.knowledge_base_id == self.selected_knowledge_base)
            .collect::<Vec<_>>();
        let can_send = !self.busy && selected_thread.is_some();
        let can_save = !self.busy && self.can_save();
        let placement = match self.preferences.overlay_placement {
            OverlayPlacement::LeftOfNotch => "left of center",
            OverlayPlacement::RightOfNotch => "right of center",
            OverlayPlacement::UnderNotch => "under center",
        };

        let recent = div()
            .id("library-recents")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(3.0));
        let recent = if is_threads {
            recent
                .when(self.threads.is_empty(), |list| {
                    list.child(
                        div()
                            .px(px(9.0))
                            .py(px(8.0))
                            .text_size(px(12.0))
                            .text_color(rgb(0x9c9c9c))
                            .child("No threads yet."),
                    )
                })
                .children(self.threads.iter().map(|thread| {
                    let id = thread.id.clone();
                    let action_id = id.clone();
                    let selected = self.selected_thread.as_ref() == Some(&id);
                    div()
                        .id(format!("thread-row-{}", id.as_str()))
                        .accessibility_id(format!("emma.thread.{}", id.as_str()))
                        .key_context("LibraryButton")
                        .focusable()
                        .tab_stop(true)
                        .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
                        .role(Role::Button)
                        .aria_label(format!("{}, updated {}", thread.title, thread.updated_at))
                        .rounded(px(4.0))
                        .border_1()
                        .border_color(if selected {
                            rgb(0x303030)
                        } else {
                            rgb(0x080808)
                        })
                        .px(px(9.0))
                        .py(px(8.0))
                        .when(selected, |row| row.bg(rgb(0x171717)))
                        .cursor_pointer()
                        .on_action(cx.listener(move |this, _: &ActivateFocused, _, cx| {
                            this.select_thread_locally(action_id.clone());
                            this.status = "Thread selected".into();
                            cx.stop_propagation();
                            cx.notify();
                        }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.select_thread_locally(id.clone());
                            this.status = "Thread selected".into();
                            cx.notify();
                        }))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(if selected {
                                    rgb(0xf3f3f3)
                                } else {
                                    rgb(0xb7b7b7)
                                })
                                .child(thread.title.clone()),
                        )
                        .child(
                            div()
                                .mt(px(3.0))
                                .font_family("Menlo")
                                .text_size(px(9.0))
                                .text_color(rgb(0x676767))
                                .child(format!("{} MESSAGES", thread.messages.len())),
                        )
                }))
        } else {
            recent
                .when(visible_pages.is_empty(), |list| {
                    list.child(
                        div()
                            .px(px(9.0))
                            .py(px(8.0))
                            .text_size(px(12.0))
                            .text_color(rgb(0x9c9c9c))
                            .child("Nothing saved yet."),
                    )
                })
                .children(visible_pages.into_iter().map(|page| {
                    let id = page.id.clone();
                    let action_id = id.clone();
                    let selected = self.selected_page.as_ref() == Some(&id);
                    div()
                        .id(format!("page-row-{}", id.as_str()))
                        .accessibility_id(format!("emma.page.{}", id.as_str()))
                        .key_context("LibraryButton")
                        .focusable()
                        .tab_stop(true)
                        .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
                        .role(Role::Button)
                        .aria_label(format!("{}, {}", page.title, page.category.as_str()))
                        .rounded(px(4.0))
                        .border_1()
                        .border_color(if selected {
                            rgb(0x39352f)
                        } else {
                            rgb(0x080808)
                        })
                        .px(px(9.0))
                        .py(px(8.0))
                        .when(selected, |row| row.bg(rgb(0x181714)))
                        .cursor_pointer()
                        .on_action(cx.listener(move |this, _: &ActivateFocused, _, cx| {
                            this.selected_page = Some(action_id.clone());
                            this.status = "Knowledge page selected".into();
                            cx.stop_propagation();
                            cx.notify();
                        }))
                        .on_click(cx.listener(move |this, _, _, cx| {
                            this.selected_page = Some(id.clone());
                            this.status = "Knowledge page selected".into();
                            cx.notify();
                        }))
                        .child(
                            div()
                                .text_size(px(12.0))
                                .text_color(if selected {
                                    rgb(0xf3f3f3)
                                } else {
                                    rgb(0xb7b7b7)
                                })
                                .child(page.title.clone()),
                        )
                        .child(
                            div()
                                .mt(px(3.0))
                                .font_family("Menlo")
                                .text_size(px(9.0))
                                .text_color(rgb(0x6f6759))
                                .child(page.category.as_str().to_uppercase()),
                        )
                }))
        };

        let knowledge_base_switcher = div()
            .id("knowledge-base-switcher")
            .role(Role::Group)
            .aria_label("Knowledge bases")
            .max_h(px(144.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(3.0))
            .children(self.knowledge_bases.iter().map(|base| {
                let id = base.id.clone();
                let action_id = id.clone();
                let selected = id == self.selected_knowledge_base;
                base_button(
                    format!("knowledge-view-base-{}", id.as_str()),
                    base.name.clone(),
                    selected,
                    true,
                )
                .on_action(cx.listener(move |this, _: &ActivateFocused, _, cx| {
                    this.select_knowledge_view_base(action_id.clone(), cx);
                    cx.stop_propagation();
                }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.select_knowledge_view_base(id.clone(), cx);
                }))
            }));

        let content = div()
            .id("library-content-scroll")
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .items_center()
            .gap(px(18.0))
            .px(px(28.0))
            .py(px(22.0));
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
                            .w_full()
                            .max_w(px(720.0))
                            .when(!assistant, |bubble| bubble.self_end())
                            .when(!assistant, |bubble| {
                                bubble
                                    .max_w(px(620.0))
                                    .rounded(px(8.0))
                                    .border_1()
                                    .border_color(rgb(0x2b2b2b))
                                    .bg(rgb(0x181818))
                                    .px(px(16.0))
                                    .py(px(13.0))
                            })
                            .when(assistant, |message| {
                                message
                                    .border_l_1()
                                    .border_color(rgb(0x6f6759))
                                    .pl(px(18.0))
                                    .py(px(3.0))
                            })
                            .text_size(px(14.0))
                            .line_height(px(23.0))
                            .text_color(if assistant {
                                rgb(0xd8d8d8)
                            } else {
                                rgb(0xf3f3f3)
                            })
                            .child(message.content.clone())
                    }))
                    .when(thread.messages.is_empty(), |content| {
                        content.child(empty_state(
                            "THREAD READY",
                            "Ask Emma anything. This conversation stays durable.",
                        ))
                    })
            } else {
                content.child(empty_state(
                    "NO THREAD SELECTED",
                    "Create a durable thread to start.",
                ))
            }
        } else if let Some(page) = &selected_page {
            content
                .child(
                    div()
                        .w_full()
                        .max_w(px(720.0))
                        .rounded(px(8.0))
                        .border_1()
                        .border_color(rgb(0x302d28))
                        .bg(rgb(0x151411))
                        .px(px(20.0))
                        .py(px(18.0))
                        .text_size(px(15.0))
                        .line_height(px(23.0))
                        .child(page.analysis.summary.clone()),
                )
                .child(
                    div()
                        .w_full()
                        .max_w(px(720.0))
                        .text_size(px(14.0))
                        .line_height(px(23.0))
                        .text_color(rgb(0xd0d0d0))
                        .child(page.analysis.body.clone()),
                )
        } else {
            content.child(empty_state(
                "KNOWLEDGE IS EXPLICIT",
                "Save & Analyze or an agent knowledge action creates a page here.",
            ))
        };

        let prompt = self.prompt.clone();
        let prompt_for_mouse = prompt.clone();
        let prompt_focused = prompt.read(cx).focus_handle(cx).is_focused(window);
        let base_name = self.base_name.clone();
        let base_name_for_mouse = base_name.clone();
        let base_name_focused = base_name.read(cx).focus_handle(cx).is_focused(window);
        let can_edit_base = !self.busy && selected_thread.is_some();
        let thread_base_picker = div()
            .id("thread-knowledge-base-picker")
            .role(Role::Group)
            .aria_label("Thread knowledge base")
            .max_h(px(132.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(3.0))
            .children(self.knowledge_bases.iter().map(|base| {
                let id = base.id.clone();
                let action_id = id.clone();
                let selected = selected_thread_base.as_ref() == Some(&id);
                base_button(
                    format!("thread-base-{}", id.as_str()),
                    base.name.clone(),
                    selected,
                    can_edit_base,
                )
                .on_action(cx.listener(move |this, _: &ActivateFocused, _, cx| {
                    this.select_thread_knowledge_base(action_id.clone(), cx);
                    cx.stop_propagation();
                }))
                .on_click(cx.listener(move |this, _, _, cx| {
                    this.select_thread_knowledge_base(id.clone(), cx);
                }))
            }));
        let base_creator = div()
            .id("knowledge-base-creator")
            .flex()
            .items_center()
            .gap(px(6.0))
            .rounded(px(6.0))
            .border_1()
            .border_color(rgb(0x292929))
            .bg(rgb(0x151515))
            .p(px(5.0))
            .child(
                InputBase::new("knowledge-base-name")
                    .accessibility_label("New knowledge base name")
                    .focused(base_name_focused)
                    .disabled(!can_edit_base)
                    .flex_1()
                    .min_w_0()
                    .h(px(32.0))
                    .px(px(8.0))
                    .flex()
                    .items_center()
                    .rounded(px(4.0))
                    .bg(rgb(0x151515))
                    .styles(|styles| styles.focused(|style| style.bg(rgb(0x1d1d1d))))
                    .on_mouse_down(MouseButton::Left, move |_, window, cx| {
                        base_name_for_mouse.update(cx, |input, cx| input.focus(window, cx));
                    })
                    .child(Input::new(&base_name)),
            )
            .child(
                action_button(
                    "create-knowledge-base",
                    "Create",
                    can_edit_base,
                    &self.create_base_focus,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.create_base_focus.focus(window, cx);
                    this.create_knowledge_base(window, cx);
                })),
            );
        let openrouter_model_picker = div()
            .id("openrouter-model-picker")
            .role(Role::Group)
            .aria_label("Privacy-filtered free OpenRouter models")
            .max_h(px(190.0))
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(3.0))
            .when(
                self.models_loaded && self.openrouter_models.is_empty(),
                |picker| {
                    picker.child(
                        div()
                            .py(px(7.0))
                            .text_size(px(10.0))
                            .text_color(rgb(0x777777))
                            .child("No free tool-capable ZDR models are available."),
                    )
                },
            )
            .children(self.openrouter_models.iter().map(|model| {
                let id = model.id.clone();
                let action_id = id.clone();
                let selected = self.selected_openrouter_model.as_ref() == Some(&id);
                openrouter_model_button(model, selected, !self.busy)
                    .on_action(cx.listener(move |this, _: &ActivateFocused, _, cx| {
                        this.select_openrouter_model(action_id.clone(), cx);
                        cx.stop_propagation();
                    }))
                    .on_click(cx.listener(move |this, _, _, cx| {
                        this.select_openrouter_model(id.clone(), cx);
                    }))
            }));
        let selected_free_model = self
            .selected_openrouter_model
            .as_deref()
            .is_some_and(is_free_openrouter_model);
        let model_selector = div()
            .id("openrouter-model-selector")
            .flex()
            .flex_col()
            .gap(px(8.0))
            .rounded(px(8.0))
            .border_1()
            .border_color(rgb(0x2b2b2b))
            .bg(rgb(0x151515))
            .p(px(10.0))
            .child(meta_label("OPENROUTER / FREE + ZDR"))
            .child(
                div()
                    .font_family("Menlo")
                    .text_size(px(9.0))
                    .line_height(px(14.0))
                    .text_color(rgb(0x9c9c9c))
                    .child(
                        self.selected_openrouter_model
                            .clone()
                            .unwrap_or_else(|| "Not selected".into()),
                    ),
            )
            .child(
                action_button(
                    "load-openrouter-models",
                    if self.models_loaded {
                        "Refresh models"
                    } else {
                        "Load free models"
                    },
                    !self.busy,
                    &self.load_models_focus,
                )
                .on_click(cx.listener(|this, _, window, cx| {
                    this.load_models_focus.focus(window, cx);
                    this.load_openrouter_models(cx);
                })),
            )
            .when(self.models_loaded, |selector| {
                selector.child(openrouter_model_picker)
            })
            .when(selected_free_model, |selector| {
                selector.child(
                    div()
                        .id("openrouter-free-model-privacy-warning")
                        .role(Role::Status)
                        .aria_label(FREE_MODEL_PRIVACY_WARNING)
                        .rounded(px(5.0))
                        .border_1()
                        .border_color(rgb(0x5a4427))
                        .bg(rgb(0x211a11))
                        .p(px(9.0))
                        .font_family("Menlo")
                        .text_size(px(9.0))
                        .line_height(px(14.0))
                        .text_color(rgb(0xd8ad68))
                        .child(format!(
                            "FREE MODEL PRIVACY\n\n{FREE_MODEL_PRIVACY_WARNING}"
                        )),
                )
            });
        let title = if is_threads {
            selected_thread
                .as_ref()
                .map_or("Threads", |thread| thread.title.as_str())
        } else {
            selected_page
                .as_ref()
                .map_or("Knowledge Base", |page| page.title.as_str())
        };

        let inspector = div()
            .id("library-inspector")
            .w(px(246.0))
            .h_full()
            .min_h_0()
            .overflow_y_scroll()
            .flex()
            .flex_col()
            .gap(px(16.0))
            .p(px(18.0))
            .border_l_1()
            .border_color(rgb(0x242424))
            .bg(rgb(0x0c0c0c))
            .child(meta_label(if is_threads {
                "THREAD CONTEXT"
            } else {
                "KNOWLEDGE DETAILS"
            }));
        let inspector = if is_threads {
            if let Some(thread) = &selected_thread {
                let assistant_count = thread
                    .messages
                    .iter()
                    .filter(|message| message.role == ThreadRole::Assistant)
                    .count();
                let linked_pages = self
                    .pages
                    .iter()
                    .filter(|page| page.source_thread_id.as_ref() == Some(&thread.id))
                    .count();
                inspector
                    .child(inspector_card(
                        "DURABLE THREAD",
                        vec![
                            ("CREATED", thread.created_at.to_string()),
                            ("UPDATED", thread.updated_at.to_string()),
                            ("MESSAGES", thread.messages.len().to_string()),
                            ("RESPONSES", assistant_count.to_string()),
                            ("SAVED PAGES", linked_pages.to_string()),
                        ],
                    ))
                    .child(meta_label("MODEL"))
                    .child(model_selector)
                    .child(meta_label("KNOWLEDGE BASE"))
                    .child(thread_base_picker)
                    .child(base_creator)
                    .child(
                        div()
                            .mt_auto()
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(rgb(0x292929))
                            .p(px(12.0))
                            .text_size(px(11.0))
                            .line_height(px(17.0))
                            .text_color(rgb(0x777777))
                            .child(
                                "Save & Analyze and agent knowledge actions write only to this base.",
                            ),
                    )
            } else {
                inspector.child(empty_state("NO CONTEXT", "Select a thread to inspect it."))
            }
        } else if let Some(page) = &selected_page {
            inspector
                .child(inspector_card(
                    "ANALYSIS RUN",
                    vec![
                        ("ADDED", page.added_at.to_string()),
                        ("ANALYZED", page.analyzed_at.to_string()),
                        ("MODEL", page.telemetry.model.clone()),
                        (
                            "TOKENS",
                            format!(
                                "{} in / {} out",
                                page.telemetry.input_tokens, page.telemetry.output_tokens
                            ),
                        ),
                        ("SUBAGENTS", page.telemetry.subagent_count.to_string()),
                    ],
                ))
                .child(meta_label(&format!("SOURCES / {}", page.sources.len())))
                .child(
                    div()
                        .id("knowledge-sources")
                        .flex_1()
                        .min_h_0()
                        .overflow_y_scroll()
                        .flex()
                        .flex_col()
                        .children(page.sources.iter().enumerate().map(|(index, source)| {
                            div()
                                .id(("knowledge-source", index))
                                .border_b_1()
                                .border_color(rgb(0x222222))
                                .py(px(11.0))
                                .child(
                                    div()
                                        .text_size(px(12.0))
                                        .text_color(rgb(0xd0d0d0))
                                        .child(source.title.clone()),
                                )
                                .child(
                                    div()
                                        .mt(px(5.0))
                                        .text_size(px(10.0))
                                        .line_height(px(15.0))
                                        .text_color(rgb(0x6f6759))
                                        .child(source.url.as_str().to_owned()),
                                )
                        }))
                        .when(page.sources.is_empty(), |sources| {
                            sources.child(
                                div()
                                    .text_size(px(11.0))
                                    .text_color(rgb(0x676767))
                                    .child("No cited sources."),
                            )
                        }),
                )
        } else {
            inspector.child(empty_state("NO DETAILS", "Select a knowledge page."))
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
            .bg(rgb(0x101010))
            .text_color(rgb(0xf3f3f3))
            .child(
                div()
                    .w(px(210.0))
                    .h_full()
                    .flex()
                    .flex_col()
                    .gap(px(4.0))
                    .p(px(12.0))
                    .border_r_1()
                    .border_color(rgb(0x242424))
                    .bg(rgb(0x080808))
                    .child(
                        div()
                            .h(px(42.0))
                            .flex()
                            .items_center()
                            .gap(px(9.0))
                            .mb(px(6.0))
                            .child(
                                div()
                                    .size(px(26.0))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .rounded(px(4.0))
                                    .border_1()
                                    .border_color(rgb(0x2d2d2d))
                                    .text_color(rgb(0x6f6759))
                                    .child("◇"),
                            )
                            .child(div().font_family("Menlo").text_size(px(11.0)).child("EMMA")),
                    )
                    .child(
                        Button::new("new-thread")
                            .key_context("LibraryButton")
                            .disabled(self.busy)
                            .tab_stop(!self.busy)
                            .track_focus(&self.new_focus)
                            .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
                            .accessibility_label("New thread")
                            .rounded(px(4.0))
                            .border_1()
                            .border_color(rgb(0x303030))
                            .px(px(9.0))
                            .py(px(8.0))
                            .bg(rgb(0x121212))
                            .font_family("Menlo")
                            .text_size(px(10.0))
                            .when(!self.busy, |button| button.cursor_pointer())
                            .on_click(cx.listener(|this, _, window, cx| {
                                this.new_focus.focus(window, cx);
                                this.new_thread(&NewThread, window, cx);
                            }))
                            .child("＋  NEW THREAD"),
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
                    .when(!is_threads, |sidebar| {
                        sidebar
                            .child(
                                div()
                                    .mt(px(14.0))
                                    .mb(px(5.0))
                                    .px(px(9.0))
                                    .child(meta_label("KNOWLEDGE BASES")),
                            )
                            .child(knowledge_base_switcher)
                    })
                    .child(div().mt(px(14.0)).mb(px(5.0)).px(px(9.0)).child(meta_label(
                        if is_threads {
                            "RECENT THREADS"
                        } else {
                            "SAVED PAGES"
                        },
                    )))
                    .child(recent)
                    .child(
                        div()
                            .mt_auto()
                            .pt(px(10.0))
                            .border_t_1()
                            .border_color(rgb(0x202020))
                            .font_family("Menlo")
                            .text_size(px(9.0))
                            .text_color(rgb(0x666666))
                            .child("CAPTURE / EXPLICIT ONLY"),
                    )
                    .child(
                        div()
                            .font_family("Menlo")
                            .text_size(px(9.0))
                            .text_color(rgb(0x666666))
                            .child(format!("NOTCH / {}", placement.to_uppercase())),
                    ),
            )
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
                    .min_h_0()
                    .child(
                        div()
                            .h(px(64.0))
                            .flex_none()
                            .flex()
                            .items_center()
                            .justify_between()
                            .px(px(24.0))
                            .border_b_1()
                            .border_color(rgb(0x222222))
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        div()
                                            .font_family("Menlo")
                                            .text_size(px(9.0))
                                            .text_color(if is_threads {
                                                rgb(0x777777)
                                            } else {
                                                rgb(0x6f6759)
                                            })
                                            .child(if is_threads {
                                                "THREAD"
                                            } else {
                                                "KNOWLEDGE PAGE"
                                            }),
                                    )
                                    .child(
                                        div()
                                            .mt(px(4.0))
                                            .truncate()
                                            .text_size(px(17.0))
                                            .font_weight(FontWeight::MEDIUM)
                                            .child(title.to_owned()),
                                    ),
                            )
                            .child(
                                div()
                                    .id("library-status")
                                    .role(Role::Status)
                                    .aria_label(self.status.clone())
                                    .flex_none()
                                    .flex()
                                    .items_center()
                                    .gap(px(7.0))
                                    .font_family("Menlo")
                                    .text_size(px(9.0))
                                    .text_color(rgb(0x777777))
                                    .child(div().size(px(5.0)).rounded_full().bg(if self.busy {
                                        rgb(0x6f6759)
                                    } else {
                                        rgb(0x98ff38)
                                    }))
                                    .child(self.status.clone()),
                            ),
                    )
                    .child(content)
                    .when(is_threads, |main| {
                        main.child(
                            div()
                                .flex_none()
                                .mx(px(24.0))
                                .mb(px(20.0))
                                .self_stretch()
                                .flex()
                                .justify_center()
                                .child(
                                    div()
                                        .w_full()
                                        .max_w(px(760.0))
                                        .flex()
                                        .items_center()
                                        .gap(px(8.0))
                                        .rounded(px(8.0))
                                        .border_1()
                                        .border_color(rgb(0x303030))
                                        .bg(rgb(0x191919))
                                        .p(px(6.0))
                                        .child(
                                            InputBase::new("thread-prompt")
                                                .accessibility_label("Thread prompt")
                                                .focused(prompt_focused)
                                                .disabled(!can_send)
                                                .flex_1()
                                                .h(px(40.0))
                                                .px(px(12.0))
                                                .flex()
                                                .items_center()
                                                .rounded(px(4.0))
                                                .bg(rgb(0x191919))
                                                .styles(|styles| {
                                                    styles.focused(|style| style.bg(rgb(0x1d1d1d)))
                                                })
                                                .on_mouse_down(
                                                    MouseButton::Left,
                                                    move |_, window, cx| {
                                                        prompt_for_mouse.update(cx, |input, cx| {
                                                            input.focus(window, cx)
                                                        });
                                                    },
                                                )
                                                .child(Input::new(&prompt)),
                                        )
                                        .child(
                                            action_button(
                                                "send-message",
                                                "Send",
                                                can_send,
                                                &self.send_focus,
                                            )
                                            .on_click(
                                                cx.listener(|this, _, window, cx| {
                                                    this.send_focus.focus(window, cx);
                                                    this.submit(window, cx);
                                                }),
                                            ),
                                        )
                                        .child(
                                            action_button(
                                                "save-analysis",
                                                "Save & Analyze",
                                                can_save,
                                                &self.save_focus,
                                            )
                                            .on_click(
                                                cx.listener(|this, _, window, cx| {
                                                    this.save_focus.focus(window, cx);
                                                    this.save(&SaveToKnowledgeBase, window, cx);
                                                }),
                                            ),
                                        ),
                                ),
                        )
                    }),
            )
            .child(inspector)
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
        .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
        .role(Role::Button)
        .aria_label(label)
        .rounded(px(4.0))
        .px(px(9.0))
        .py(px(8.0))
        .font_family("Menlo")
        .text_size(px(10.0))
        .text_color(if selected {
            rgb(0xf3f3f3)
        } else {
            rgb(0x9c9c9c)
        })
        .when(selected, |button| {
            button
                .border_1()
                .border_color(rgb(0x2d2d2d))
                .bg(rgb(0x151515))
        })
        .cursor_pointer()
        .child(label)
}

fn action_button(
    id: &'static str,
    label: &'static str,
    enabled: bool,
    focus: &FocusHandle,
) -> Button {
    let secondary = label == "Save & Analyze";
    Button::new(id)
        .key_context("LibraryButton")
        .disabled(!enabled)
        .tab_stop(enabled)
        .track_focus(focus)
        .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
        .accessibility_label(if enabled {
            label.to_owned()
        } else {
            format!("{label}, unavailable")
        })
        .rounded(px(4.0))
        .border_1()
        .border_color(if enabled {
            rgb(0x444444)
        } else {
            rgb(0x2a2a2a)
        })
        .bg(if enabled && !secondary {
            rgb(0xf3f3f3)
        } else {
            rgb(0x202020)
        })
        .text_color(if enabled && !secondary {
            rgb(0x080808)
        } else if enabled {
            rgb(0xb7b7b7)
        } else {
            rgb(0x666666)
        })
        .font_family("Menlo")
        .text_size(px(9.0))
        .px(px(12.0))
        .py(px(9.0))
        .when(enabled, |button| button.cursor_pointer())
        .child(label)
}

fn base_button(id: String, label: String, selected: bool, enabled: bool) -> Button {
    let accessibility_id = format!("emma.{id}");
    let accessible_label = if !enabled {
        format!("{label}, unavailable")
    } else if selected {
        format!("{label}, selected")
    } else {
        label.clone()
    };
    Button::new(id)
        .accessibility_id(accessibility_id)
        .key_context("LibraryButton")
        .disabled(!enabled)
        .tab_stop(enabled)
        .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
        .accessibility_label(accessible_label)
        .rounded(px(4.0))
        .border_1()
        .border_color(if selected {
            rgb(0x39352f)
        } else {
            rgb(0x181818)
        })
        .bg(if selected {
            rgb(0x181714)
        } else {
            rgb(0x0c0c0c)
        })
        .text_color(if selected {
            rgb(0xf3f3f3)
        } else if enabled {
            rgb(0x9c9c9c)
        } else {
            rgb(0x5d5d5d)
        })
        .font_family("Menlo")
        .text_size(px(9.0))
        .px(px(9.0))
        .py(px(7.0))
        .when(enabled, |button| button.cursor_pointer())
        .child(format!("{}  {label}", if selected { "◆" } else { "◇" }))
}

fn openrouter_model_button(model: &OpenRouterModel, selected: bool, enabled: bool) -> Button {
    let context = format_context_length(model.context_length);
    let accessibility_label = format!(
        "{}, free OpenRouter model, {context} token context{}",
        model.name,
        if selected { ", selected" } else { "" }
    );
    Button::new(format!("openrouter-model-{}", model.id))
        .key_context("LibraryButton")
        .disabled(!enabled)
        .tab_stop(enabled)
        .focus_visible(|style| style.border_1().border_color(rgb(0x98ff38)))
        .accessibility_label(accessibility_label)
        .w_full()
        .rounded(px(4.0))
        .border_1()
        .border_color(if selected {
            rgb(0x5a4427)
        } else {
            rgb(0x292929)
        })
        .bg(if selected {
            rgb(0x211a11)
        } else {
            rgb(0x101010)
        })
        .px(px(8.0))
        .py(px(7.0))
        .when(enabled, |button| button.cursor_pointer())
        .child(
            div()
                .w_full()
                .min_w_0()
                .child(
                    div()
                        .truncate()
                        .text_size(px(10.0))
                        .text_color(if selected {
                            rgb(0xf0c27b)
                        } else {
                            rgb(0xc8c8c8)
                        })
                        .child(model.name.clone()),
                )
                .child(
                    div()
                        .mt(px(3.0))
                        .font_family("Menlo")
                        .text_size(px(8.0))
                        .text_color(rgb(0x777777))
                        .child(format!("{context} CONTEXT")),
                ),
        )
}

fn is_free_openrouter_model(model_id: &str) -> bool {
    model_id.ends_with(":free") || model_id == "openrouter/free"
}

fn format_context_length(tokens: u64) -> String {
    if tokens >= 1_000_000 {
        format!("{:.1}M", tokens as f64 / 1_000_000.0)
    } else {
        format!("{}K", tokens / 1_000)
    }
}

fn meta_label(label: &str) -> gpui::Div {
    div()
        .font_family("Menlo")
        .text_size(px(9.0))
        .text_color(rgb(0x777777))
        .child(label.to_owned())
}

fn empty_state(label: &str, message: &str) -> gpui::Div {
    div()
        .w_full()
        .max_w(px(720.0))
        .rounded(px(4.0))
        .border_1()
        .border_color(rgb(0x242424))
        .p(px(18.0))
        .child(meta_label(label))
        .child(
            div()
                .mt(px(8.0))
                .text_size(px(13.0))
                .text_color(rgb(0x9c9c9c))
                .child(message.to_owned()),
        )
}

fn inspector_card(label: &str, facts: Vec<(&'static str, String)>) -> gpui::Div {
    div()
        .rounded(px(8.0))
        .border_1()
        .border_color(rgb(0x2b2b2b))
        .bg(rgb(0x151515))
        .p(px(14.0))
        .child(meta_label(label))
        .children(facts.into_iter().map(|(name, value)| {
            div().mt(px(12.0)).child(meta_label(name)).child(
                div()
                    .mt(px(4.0))
                    .text_size(px(11.0))
                    .line_height(px(16.0))
                    .text_color(rgb(0xc8c8c8))
                    .child(value),
            )
        }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn free_model_labels_are_compact_and_explicit() {
        assert!(is_free_openrouter_model("openai/gpt-oss-20b:free"));
        assert!(!is_free_openrouter_model("openai/gpt-oss-20b"));
        assert_eq!(format_context_length(131_072), "131K");
        assert_eq!(format_context_length(1_048_576), "1.0M");
    }
}
