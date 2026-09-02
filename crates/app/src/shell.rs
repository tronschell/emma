use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, Hsla, InteractiveElement as _, IntoElement, MouseButton,
    MouseMoveEvent, ParentElement as _, Pixels, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, WindowControlArea,
    accesskit::{Orientation, Role},
    div,
    prelude::FluentBuilder as _,
    px, relative, transparent_black,
};
use gpui_component::{
    Icon, IconName, Selectable as _, StyledExt as _,
    button::{Button, ButtonCustomVariant, ButtonVariants as _},
    h_flex,
    input::{Input, InputState},
    menu::{ContextMenuExt as _, PopupMenuItem},
    v_flex,
};

use crate::{
    navigation::{NAV_VIEW_SPECS, WorkspaceMode},
    theme::EmmaTheme,
};

pub type ShellCallback = Rc<dyn Fn(ShellAction, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ShellPane {
    Sidebar,
    Inspector,
    Browser,
    Terminal,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InspectorTab {
    Context,
    Run,
    Machine,
}

impl InspectorTab {
    pub const ALL: [Self; 3] = [Self::Context, Self::Run, Self::Machine];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Context => "context",
            Self::Run => "run",
            Self::Machine => "machine",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Context => "Context",
            Self::Run => "Run",
            Self::Machine => "Machine",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ShellStatus {
    #[default]
    Idle,
    Running,
    Done,
    Waiting,
    Failed,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ShellAction {
    Search,
    NewThread,
    ToggleSidebar,
    ToggleNavIcons,
    ToggleNavMore,
    SelectMode(WorkspaceMode),
    SelectProject(SharedString),
    ConnectProject,
    SelectThread(SharedString),
    ArchiveThread(SharedString),
    RenameThread(SharedString),
    CancelRenameThread,
    SelectInspectorTab(InspectorTab),
    BeginResize(ShellPane),
    ResizeBy(ShellPane, i16),
    ResizeTo(ShellPane, i16),
    EndResize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellRow {
    pub id: SharedString,
    pub label: SharedString,
    pub count: Option<SharedString>,
    pub tag: Option<SharedString>,
    pub status: ShellStatus,
    pub accent: Option<Hsla>,
    pub selected: bool,
}

impl ShellRow {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            count: None,
            tag: None,
            status: ShellStatus::default(),
            accent: None,
            selected: false,
        }
    }

    pub fn count(mut self, count: impl Into<SharedString>) -> Self {
        self.count = Some(count.into());
        self
    }

    pub fn tag(mut self, tag: impl Into<SharedString>) -> Self {
        self.tag = Some(tag.into());
        self
    }

    pub fn status(mut self, status: ShellStatus) -> Self {
        self.status = status;
        self
    }

    pub fn accent(mut self, accent: Hsla) -> Self {
        self.accent = Some(accent);
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShellProject {
    pub id: SharedString,
    pub label: SharedString,
    pub count: Option<SharedString>,
    pub threads: Vec<ShellRow>,
    pub expanded: bool,
    pub selected: bool,
}

impl ShellProject {
    pub fn new(id: impl Into<SharedString>, label: impl Into<SharedString>) -> Self {
        Self {
            id: id.into(),
            label: label.into(),
            count: None,
            threads: Vec::new(),
            expanded: true,
            selected: false,
        }
    }

    pub fn count(mut self, count: impl Into<SharedString>) -> Self {
        self.count = Some(count.into());
        self
    }

    pub fn thread(mut self, thread: ShellRow) -> Self {
        self.threads.push(thread);
        self
    }

    pub fn threads(mut self, threads: impl IntoIterator<Item = ShellRow>) -> Self {
        self.threads.extend(threads);
        self
    }

    pub fn expanded(mut self, expanded: bool) -> Self {
        self.expanded = expanded;
        self
    }

    pub fn selected(mut self, selected: bool) -> Self {
        self.selected = selected;
        self
    }
}

#[derive(IntoElement)]
pub struct WorkspaceShell {
    main: AnyElement,
    search_state: Option<Entity<InputState>>,
    inspector: Option<AnyElement>,
    inspector_visible: bool,
    browser: Option<AnyElement>,
    browser_visible: bool,
    terminal: Option<AnyElement>,
    terminal_visible: bool,
    terminal_height: Option<Pixels>,
    resizing_pane: Option<ShellPane>,
    inspector_title: SharedString,
    inspector_tab: InspectorTab,
    active_mode: WorkspaceMode,
    selected_project: Option<SharedString>,
    sidebar_collapsed: bool,
    sidebar_width: Option<Pixels>,
    inspector_width: Option<Pixels>,
    browser_width: Option<Pixels>,
    renaming_thread: Option<SharedString>,
    rename_state: Option<Entity<InputState>>,
    nav_icons: bool,
    nav_more: bool,
    nav_order: Vec<WorkspaceMode>,
    nav_counts: Vec<(WorkspaceMode, SharedString)>,
    projects: Vec<ShellProject>,
    status_label: SharedString,
    callback: Option<ShellCallback>,
}

impl WorkspaceShell {
    pub fn new(main: impl IntoElement) -> Self {
        Self {
            main: main.into_any_element(),
            search_state: None,
            inspector: None,
            inspector_visible: false,
            browser: None,
            browser_visible: false,
            terminal: None,
            terminal_visible: false,
            terminal_height: None,
            resizing_pane: None,
            inspector_title: "Inspector".into(),
            inspector_tab: InspectorTab::Context,
            active_mode: WorkspaceMode::Threads,
            selected_project: None,
            sidebar_collapsed: false,
            sidebar_width: None,
            inspector_width: None,
            browser_width: None,
            renaming_thread: None,
            rename_state: None,
            nav_icons: false,
            nav_more: false,
            nav_order: default_nav_order(),
            nav_counts: Vec::new(),
            projects: Vec::new(),
            status_label: "Agent ready".into(),
            callback: None,
        }
    }

    pub fn search_state(mut self, state: &Entity<InputState>) -> Self {
        self.search_state = Some(state.clone());
        self
    }

    pub fn inspector(mut self, body: impl IntoElement) -> Self {
        self.inspector = Some(body.into_any_element());
        self.inspector_visible = true;
        self
    }

    pub fn inspector_visible(mut self, visible: bool) -> Self {
        self.inspector_visible = visible;
        self
    }

    pub fn browser(mut self, body: impl IntoElement) -> Self {
        self.browser = Some(body.into_any_element());
        self.browser_visible = true;
        self
    }

    pub fn browser_visible(mut self, visible: bool) -> Self {
        self.browser_visible = visible;
        self
    }

    pub fn terminal(mut self, terminal: impl IntoElement) -> Self {
        self.terminal = Some(terminal.into_any_element());
        self.terminal_visible = true;
        self
    }

    pub fn terminal_visible(mut self, visible: bool) -> Self {
        self.terminal_visible = visible;
        self
    }

    pub fn terminal_height(mut self, height: impl Into<Pixels>) -> Self {
        self.terminal_height = Some(height.into());
        self
    }

    pub fn resizing_pane(mut self, pane: Option<ShellPane>) -> Self {
        self.resizing_pane = pane;
        self
    }

    pub fn inspector_title(mut self, title: impl Into<SharedString>) -> Self {
        self.inspector_title = title.into();
        self
    }

    pub fn inspector_tab(mut self, tab: InspectorTab) -> Self {
        self.inspector_tab = tab;
        self
    }

    pub fn active_mode(mut self, mode: WorkspaceMode) -> Self {
        self.active_mode = mode;
        self
    }

    pub fn selected_project(mut self, project: impl Into<SharedString>) -> Self {
        self.selected_project = Some(project.into());
        self
    }

    pub fn sidebar_collapsed(mut self, collapsed: bool) -> Self {
        self.sidebar_collapsed = collapsed;
        self
    }

    pub fn sidebar_width(mut self, width: impl Into<Pixels>) -> Self {
        self.sidebar_width = Some(width.into());
        self
    }

    pub fn inspector_width(mut self, width: impl Into<Pixels>) -> Self {
        self.inspector_width = Some(width.into());
        self
    }

    pub fn browser_width(mut self, width: impl Into<Pixels>) -> Self {
        self.browser_width = Some(width.into());
        self
    }

    pub fn rename_state(
        mut self,
        thread_id: Option<impl Into<SharedString>>,
        state: &Entity<InputState>,
    ) -> Self {
        self.renaming_thread = thread_id.map(Into::into);
        self.rename_state = Some(state.clone());
        self
    }

    pub fn nav_icons(mut self, nav_icons: bool) -> Self {
        self.nav_icons = nav_icons;
        self
    }

    pub fn nav_more(mut self, nav_more: bool) -> Self {
        self.nav_more = nav_more;
        self
    }

    pub fn nav_order(mut self, order: impl IntoIterator<Item = WorkspaceMode>) -> Self {
        self.nav_order = order.into_iter().collect();
        self
    }

    pub fn nav_count(mut self, mode: WorkspaceMode, count: impl Into<SharedString>) -> Self {
        self.nav_counts.push((mode, count.into()));
        self
    }

    pub fn project(mut self, project: ShellProject) -> Self {
        self.projects.push(project);
        self
    }

    pub fn projects(mut self, projects: impl IntoIterator<Item = ShellProject>) -> Self {
        self.projects.extend(projects);
        self
    }

    pub fn status_label(mut self, label: impl Into<SharedString>) -> Self {
        self.status_label = label.into();
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(ShellAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for WorkspaceShell {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let colors = theme.colors;
        let dimensions = theme.dimensions;
        let sidebar_width = bounded_width(
            self.sidebar_width,
            dimensions.sidebar_width,
            dimensions.sidebar_min_width,
            dimensions.sidebar_max_width,
        );
        let inspector_width = bounded_width(
            self.inspector_width,
            dimensions.inspector_width,
            dimensions.inspector_min_width,
            dimensions.inspector_max_width,
        );
        let browser_width = bounded_width(
            self.browser_width,
            px(crate::pane_layout::PaneLayout::default().browser_width),
            px(crate::pane_layout::MIN_BROWSER_WIDTH),
            px(crate::pane_layout::WIDE_BROWSER_WIDTH),
        );
        let safe_region = titlebar_safe_region(
            if self.sidebar_collapsed {
                px(8.)
            } else {
                sidebar_width
            },
            dimensions.sidebar_top_padding,
        );
        let sidebar = render_sidebar(&self, &theme, sidebar_width, cx);
        let sidebar_toggle =
            render_sidebar_toggle(self.sidebar_collapsed, &self.callback, &theme, cx);
        let terminal_height = px(self
            .terminal_height
            .unwrap_or(px(260.))
            .as_f32()
            .clamp(120., 720.));
        let mut top = h_flex().flex_1().min_w_0().min_h_0().child(
            div()
                .id("shell-main")
                .h_full()
                .min_w_0()
                .flex_1()
                .bg(colors.bg)
                .child(self.main),
        );
        if self.inspector_visible {
            top = top.child(render_inspector(
                self.inspector_title,
                self.inspector_tab,
                self.inspector,
                &self.callback,
                &theme,
                inspector_width,
                cx,
            ));
        }
        if self.browser_visible
            && let Some(browser) = self.browser
        {
            top = top.child(render_browser(
                browser,
                browser_width,
                &self.callback,
                &theme,
            ));
        }
        let mut workspace = v_flex()
            .id("shell-workspace")
            .h_full()
            .min_w_0()
            .min_h_0()
            .flex_1()
            .bg(colors.bg)
            .child(top);
        if self.terminal_visible
            && let Some(terminal) = self.terminal
        {
            workspace = workspace.child(render_terminal(
                terminal,
                terminal_height,
                &self.callback,
                &theme,
            ));
        }
        let mut root = h_flex()
            .relative()
            .size_full()
            .bg(transparent_black())
            .text_color(colors.text)
            .font_family(theme.typography.font.clone())
            .text_size(theme.typography.fs_md)
            .line_height(relative(theme.typography.line_height));
        root = root.child(safe_region).child(sidebar).child(workspace);
        if let (Some(pane), Some(callback)) = (self.resizing_pane, self.callback.clone()) {
            let move_callback = callback.clone();
            root = root
                .on_mouse_move(move |event: &MouseMoveEvent, window, cx| {
                    if event.dragging() {
                        let position = match pane {
                            ShellPane::Sidebar | ShellPane::Inspector | ShellPane::Browser => {
                                event.position.x
                            }
                            ShellPane::Terminal => event.position.y,
                        };
                        move_callback(
                            ShellAction::ResizeTo(pane, pixel_coordinate(position)),
                            window,
                            cx,
                        );
                    }
                })
                .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                    callback(ShellAction::EndResize, window, cx);
                });
        }
        root.child(sidebar_toggle)
    }
}

fn pixel_coordinate(value: Pixels) -> i16 {
    value
        .as_f32()
        .round()
        .clamp(f32::from(i16::MIN), f32::from(i16::MAX)) as i16
}

fn default_nav_order() -> Vec<WorkspaceMode> {
    NAV_VIEW_SPECS
        .iter()
        .filter_map(|view| WorkspaceMode::from_id(view.id))
        .collect()
}

fn titlebar_safe_region(width: gpui::Pixels, height: gpui::Pixels) -> impl IntoElement {
    div()
        .id("shell-titlebar-safe")
        .absolute()
        .top_0()
        .left_0()
        .w(width)
        .h(height)
        .bg(transparent_black())
        .window_control_area(WindowControlArea::Drag)
}

fn render_sidebar(
    shell: &WorkspaceShell,
    theme: &EmmaTheme,
    sidebar_width: Pixels,
    cx: &mut App,
) -> AnyElement {
    let colors = theme.colors;
    let spacing = theme.spacing;
    let dimensions = theme.dimensions;
    let collapsed = shell.sidebar_collapsed;
    let icon_only = shell.nav_icons;
    let gutter = if collapsed { px(9.) } else { spacing.s4 };
    let sidebar_surface_2 = colors.text.alpha(0.0588);
    let sidebar_surface_3 = colors.text.alpha(0.102);
    let sidebar_surface_4 = colors.text.alpha(0.161);
    let mut sidebar = v_flex()
        .relative()
        .h_full()
        .w(sidebar_width)
        .flex_none()
        .min_h_0()
        .overflow_hidden()
        .pt(dimensions.sidebar_top_padding)
        .bg(colors.chrome.opacity(0.35))
        .border_r_1()
        .border_color(colors.border_strong)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_sm)
        .line_height(relative(1.2));
    if collapsed {
        sidebar = sidebar.absolute().top_0().left_0().opacity(0.);
    }

    let mut brand = h_flex()
        .flex_none()
        .px(gutter)
        .pt(spacing.s1)
        .pb(spacing.s3)
        .gap(spacing.s2);
    if !collapsed {
        let search = match shell.search_state.clone() {
            Some(state) => render_search_input(state, theme, sidebar_surface_3),
            None => render_search_button(theme, &shell.callback, sidebar_surface_3, cx),
        };
        brand = brand.child(search).child(render_icon_button(
            "shell-new-thread",
            IconName::Plus,
            "New thread",
            ShellAction::NewThread,
            colors.text_2,
            transparent(colors),
            sidebar_surface_3,
            sidebar_surface_4,
            &shell.callback,
            cx,
        ));
    } else {
        brand = brand.justify_center().child(render_icon_button(
            "shell-new-thread-collapsed",
            IconName::Plus,
            "New thread",
            ShellAction::NewThread,
            colors.text_2,
            transparent(colors),
            sidebar_surface_3,
            sidebar_surface_4,
            &shell.callback,
            cx,
        ));
    }
    sidebar = sidebar.child(brand);

    let mut nav = if icon_only {
        h_flex().gap(spacing.s1).px(gutter).py(spacing.s2)
    } else {
        v_flex().py(spacing.s2)
    };
    let nav_views = visible_nav_views(shell);
    for mode in nav_views {
        let label: SharedString = mode.label().to_uppercase().into();
        let count = shell
            .nav_counts
            .iter()
            .find(|(candidate, _)| *candidate == mode)
            .map(|(_, count)| count.clone());
        let mut button = render_nav_button(
            nav_button_id(mode),
            mode,
            mode_icon(mode),
            label,
            count,
            shell.active_mode == mode,
            icon_only,
            theme,
            sidebar_surface_2,
            sidebar_surface_3,
            sidebar_surface_4,
            &shell.callback,
            cx,
        );
        if icon_only {
            button = button.flex_1().w_auto().px(px(0.)).justify_center();
        }
        nav = nav.child(button);
    }
    let show_more = shell.nav_order.len() > visible_nav_views(shell).len() || shell.nav_more;
    if show_more {
        let label: SharedString = if shell.nav_more { "LESS" } else { "MORE" }.into();
        let mut more = render_nav_button(
            "shell-nav-more",
            WorkspaceMode::Settings,
            IconName::Ellipsis,
            label,
            None,
            false,
            icon_only,
            theme,
            sidebar_surface_2,
            sidebar_surface_3,
            sidebar_surface_4,
            &None,
            cx,
        );
        more = add_action(more, ShellAction::ToggleNavMore, &shell.callback);
        if icon_only {
            more = more.flex_1().w_auto().px(px(0.)).justify_center();
        }
        nav = nav.child(more);
    }
    sidebar = sidebar.child(
        nav.id("shell-sidebar-nav")
            .flex_none()
            .border_b_1()
            .border_color(colors.border),
    );

    let mut projects = v_flex()
        .id("shell-projects")
        .flex_1()
        .min_h_0()
        .overflow_y_scroll()
        .pb(spacing.s3);
    if !collapsed {
        projects = projects.child(
            h_flex()
                .flex_none()
                .px(gutter)
                .pt(spacing.s4)
                .pb(spacing.s2)
                .border_b_1()
                .border_color(colors.border)
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .truncate()
                        .text_color(colors.text_3)
                        .text_size(theme.typography.fs_2xs)
                        .child("PROJECTS"),
                )
                .child(
                    render_icon_button(
                        "shell-connect-project",
                        IconName::Plus,
                        "Connect a folder",
                        ShellAction::ConnectProject,
                        colors.text_3,
                        transparent(colors),
                        sidebar_surface_3,
                        sidebar_surface_4,
                        &shell.callback,
                        cx,
                    )
                    .size(px(24.)),
                ),
        );
    }
    for project in &shell.projects {
        let project_count = project
            .count
            .clone()
            .unwrap_or_else(|| project.threads.len().to_string().into());
        let mut project_button = render_row_button(
            format!("shell-project-{}", project.id),
            IconName::FolderClosed,
            project.label.clone(),
            Some(project_count),
            None,
            ShellStatus::Idle,
            None,
            project.selected
                || shell
                    .selected_project
                    .as_ref()
                    .is_some_and(|selected| selected == &project.id),
            collapsed,
            false,
            0,
            theme,
            sidebar_surface_2,
            sidebar_surface_3,
            sidebar_surface_4,
            &shell.callback,
            ShellAction::SelectProject(project.id.clone()),
            cx,
        );
        if shell.nav_icons && !collapsed {
            project_button = project_button.font_family(theme.typography.font_mono.clone());
        }
        projects = projects.child(project_button);
        if project.expanded {
            for thread in &project.threads {
                projects = projects.child(render_thread_row(
                    thread,
                    shell
                        .renaming_thread
                        .as_ref()
                        .filter(|id| *id == &thread.id)
                        .and(shell.rename_state.as_ref()),
                    collapsed,
                    30,
                    theme,
                    sidebar_surface_2,
                    sidebar_surface_3,
                    sidebar_surface_4,
                    &shell.callback,
                    cx,
                ));
            }
        }
    }
    sidebar = sidebar.child(projects);

    let mut footer = h_flex()
        .flex_none()
        .gap(spacing.s3)
        .px(gutter)
        .py(spacing.s2)
        .border_t_1()
        .border_color(colors.border);
    if !collapsed {
        footer = footer.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(colors.text_2)
                .text_size(theme.typography.fs_2xs)
                .child(shell.status_label.to_uppercase()),
        );
    }
    footer = footer
        .child(
            render_icon_button(
                "shell-nav-icons",
                IconName::LayoutDashboard,
                if shell.nav_icons {
                    "Show sections as rows"
                } else {
                    "Show sections as icons"
                },
                ShellAction::ToggleNavIcons,
                if shell.nav_icons {
                    colors.text
                } else {
                    colors.text_3
                },
                if shell.nav_icons {
                    sidebar_surface_3
                } else {
                    transparent(colors)
                },
                sidebar_surface_3,
                sidebar_surface_4,
                &shell.callback,
                cx,
            )
            .toggled(shell.nav_icons),
        )
        .child(render_icon_button(
            "shell-archive",
            IconName::FolderClosed,
            "Archive",
            ShellAction::SelectMode(WorkspaceMode::Archive),
            if shell.active_mode == WorkspaceMode::Archive {
                colors.text
            } else {
                colors.text_3
            },
            if shell.active_mode == WorkspaceMode::Archive {
                sidebar_surface_3
            } else {
                transparent(colors)
            },
            sidebar_surface_3,
            sidebar_surface_4,
            &shell.callback,
            cx,
        ))
        .child(render_icon_button(
            "shell-settings",
            IconName::Settings,
            "Settings",
            ShellAction::SelectMode(WorkspaceMode::Settings),
            if shell.active_mode == WorkspaceMode::Settings {
                colors.text
            } else {
                colors.text_3
            },
            if shell.active_mode == WorkspaceMode::Settings {
                sidebar_surface_3
            } else {
                transparent(colors)
            },
            sidebar_surface_3,
            sidebar_surface_4,
            &shell.callback,
            cx,
        ));
    let sidebar = sidebar
        .child(footer)
        .when(!collapsed, |this| {
            this.child(render_resize_handle(
                ShellPane::Sidebar,
                true,
                &shell.callback,
                theme,
            ))
        })
        .into_any_element();
    if collapsed {
        let callback = shell.callback.clone();
        div()
            .id("shell-sidebar-reveal")
            .absolute()
            .top_0()
            .left_0()
            .w(px(8.))
            .h_full()
            .bg(colors.chrome.opacity(0.38))
            .on_hover(move |hovered, window, cx| {
                if *hovered && let Some(callback) = callback.clone() {
                    callback(ShellAction::ToggleSidebar, window, cx);
                }
            })
            .child(sidebar)
            .into_any_element()
    } else {
        sidebar
    }
}

fn visible_nav_views(shell: &WorkspaceShell) -> Vec<WorkspaceMode> {
    shell
        .nav_order
        .iter()
        .enumerate()
        .filter(|(index, mode)| shell.nav_more || *index < 3 || **mode == shell.active_mode)
        .map(|(_, mode)| *mode)
        .collect()
}

fn bounded_width(
    value: Option<Pixels>,
    fallback: Pixels,
    minimum: Pixels,
    maximum: Pixels,
) -> Pixels {
    px(value
        .unwrap_or(fallback)
        .as_f32()
        .clamp(minimum.as_f32(), maximum.as_f32()))
}

fn render_search_input(
    state: Entity<InputState>,
    theme: &EmmaTheme,
    background: Hsla,
) -> AnyElement {
    h_flex()
        .id("shell-search")
        .h(theme.dimensions.sidebar_search_height)
        .flex_1()
        .min_w_0()
        .gap(theme.spacing.s2)
        .px(theme.spacing.s4)
        .rounded(px(8.))
        .bg(background)
        .child(
            Icon::new(IconName::Search)
                .size(px(13.))
                .text_color(theme.colors.text_3),
        )
        .child(
            Input::new(&state)
                .appearance(false)
                .bordered(false)
                .focus_bordered(true)
                .h(theme.dimensions.sidebar_search_height)
                .flex_1()
                .min_w_0()
                .px(px(0.))
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_sm)
                .text_color(theme.colors.text),
        )
        .into_any_element()
}

fn render_search_button(
    theme: &EmmaTheme,
    callback: &Option<ShellCallback>,
    background: Hsla,
    cx: &mut App,
) -> AnyElement {
    let mut button = render_icon_button(
        "shell-search",
        IconName::Search,
        "Search",
        ShellAction::Search,
        theme.colors.text_3,
        theme.colors.text.alpha(0.51),
        background,
        background,
        callback,
        cx,
    );
    button = button
        .label("Search")
        .h(theme.dimensions.sidebar_search_height)
        .flex_1()
        .min_w_0()
        .justify_start()
        .px(theme.spacing.s4)
        .rounded(px(8.))
        .text_size(theme.typography.fs_sm)
        .font_family(theme.typography.font_mono.clone());
    button.into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn render_nav_button(
    id: impl Into<ElementId>,
    mode: WorkspaceMode,
    icon: IconName,
    label: SharedString,
    count: Option<SharedString>,
    selected: bool,
    icon_only: bool,
    theme: &EmmaTheme,
    hover: Hsla,
    _active: Hsla,
    pressed: Hsla,
    callback: &Option<ShellCallback>,
    cx: &mut App,
) -> Button {
    let icon_color = nav_color(mode, theme);
    let text_color = if selected {
        theme.colors.text
    } else {
        theme.colors.text_2
    };
    let content = h_flex()
        .size_full()
        .min_w_0()
        .gap(theme.spacing.s2)
        .child(
            Icon::new(icon)
                .size(if icon_only { px(17.) } else { px(16.) })
                .text_color(icon_color),
        )
        .when(!icon_only, |this| {
            this.child(
                div()
                    .flex_1()
                    .min_w_0()
                    .truncate()
                    .text_color(text_color)
                    .child(label.clone()),
            )
            .when_some(count.clone(), |this, count| {
                this.child(
                    div()
                        .flex_none()
                        .text_color(theme.colors.text_3)
                        .text_size(theme.typography.fs_2xs)
                        .child(count),
                )
            })
        });
    let mut button = styled_button(
        id,
        if selected {
            pressed
        } else {
            transparent(theme.colors)
        },
        text_color,
        hover,
        pressed,
        theme,
        cx,
    )
    .h(theme.dimensions.sidebar_row)
    .w_full()
    .px(theme.spacing.s4)
    .rounded(px(0.))
    .justify_start()
    .selected(selected)
    .toggled(selected)
    .accessibility_label(label.clone())
    .tooltip(label)
    .child(content);
    button = add_action(button, ShellAction::SelectMode(mode), callback);
    button
}

fn nav_button_id(mode: WorkspaceMode) -> String {
    format!("shell-nav-{}", mode.id())
}

#[allow(clippy::too_many_arguments)]
fn render_row_button(
    id: impl Into<ElementId>,
    icon: IconName,
    label: SharedString,
    count: Option<SharedString>,
    tag: Option<SharedString>,
    status: ShellStatus,
    accent: Option<Hsla>,
    selected: bool,
    icon_only: bool,
    thread: bool,
    indent: i32,
    theme: &EmmaTheme,
    hover: Hsla,
    active: Hsla,
    pressed: Hsla,
    callback: &Option<ShellCallback>,
    action: ShellAction,
    cx: &mut App,
) -> Button {
    let foreground = if selected {
        theme.colors.text
    } else {
        theme.colors.text_2
    };
    let mark = if thread {
        status_color(status, accent, theme)
    } else {
        theme.colors.text_3
    };
    let mut content = h_flex()
        .size_full()
        .min_w_0()
        .gap(theme.spacing.s2)
        .child(if thread {
            status_mark(status, mark, theme)
        } else {
            Icon::new(icon)
                .size(px(16.))
                .text_color(mark)
                .into_any_element()
        });
    if !icon_only {
        content = content.child(
            div()
                .flex_1()
                .min_w_0()
                .truncate()
                .text_color(foreground)
                .child(label.clone()),
        );
        if let Some(tag) = tag {
            content = content.child(
                div()
                    .flex_none()
                    .max_w(px(72.))
                    .truncate()
                    .px(theme.spacing.s1)
                    .text_color(theme.colors.text_3)
                    .text_size(theme.typography.fs_2xs)
                    .bg(active)
                    .child(tag),
            );
        }
        if let Some(count) = count {
            content = content.child(
                div()
                    .flex_none()
                    .text_color(theme.colors.text_3)
                    .text_size(theme.typography.fs_2xs)
                    .child(count),
            );
        }
    }
    let mut button = styled_button(
        id,
        if selected {
            pressed
        } else {
            transparent(theme.colors)
        },
        foreground,
        hover,
        pressed,
        theme,
        cx,
    )
    .h(if thread {
        px(26.)
    } else {
        theme.dimensions.sidebar_row
    })
    .w_full()
    .rounded(px(0.))
    .px(if icon_only {
        px(0.)
    } else if thread {
        px(indent as f32)
    } else {
        theme.spacing.s4
    })
    .justify_start()
    .selected(selected)
    .accessibility_label(if thread {
        format!("Open thread {label}")
    } else {
        label.to_string()
    })
    .when(icon_only, |this| this.justify_center())
    .child(content);
    button = add_action(button, action, callback);
    button
}

#[allow(clippy::too_many_arguments)]
fn render_thread_row(
    row: &ShellRow,
    rename_state: Option<&Entity<InputState>>,
    collapsed: bool,
    indent: i32,
    theme: &EmmaTheme,
    hover: Hsla,
    active: Hsla,
    pressed: Hsla,
    callback: &Option<ShellCallback>,
    cx: &mut App,
) -> AnyElement {
    if let Some(state) = rename_state {
        let cancel_callback = callback.clone();
        return h_flex()
            .id(format!("shell-thread-rename-{}", row.id))
            .h(px(26.))
            .w_full()
            .pl(px(indent as f32))
            .pr(theme.spacing.s2)
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key == "escape" {
                    window.prevent_default();
                    cx.stop_propagation();
                    if let Some(callback) = cancel_callback.clone() {
                        callback(ShellAction::CancelRenameThread, window, cx);
                    }
                }
            })
            .child(
                Input::new(state)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(true)
                    .h(px(26.))
                    .flex_1()
                    .min_w_0()
                    .px(px(4.))
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_sm)
                    .text_color(theme.colors.text),
            )
            .into_any_element();
    }
    let thread_id = row.id.clone();
    let button = render_row_button(
        format!("shell-thread-{}", row.id),
        IconName::FileText,
        row.label.clone(),
        None,
        row.tag.clone(),
        row.status,
        row.accent,
        row.selected,
        collapsed,
        true,
        indent,
        theme,
        hover,
        active,
        pressed,
        callback,
        ShellAction::SelectThread(thread_id.clone()),
        cx,
    );
    let double_click_callback = callback.clone();
    let double_click_thread_id = thread_id.clone();
    let button = button.on_click(move |event, window, cx| {
        if event.click_count() == 2
            && let Some(callback) = double_click_callback.clone()
        {
            callback(
                ShellAction::RenameThread(double_click_thread_id.clone()),
                window,
                cx,
            );
        }
    });
    let rename_callback = callback.clone();
    let rename_thread_id = thread_id.clone();
    let archive_callback = callback.clone();
    let archive_thread_id = thread_id;
    button
        .context_menu(move |menu, _, _| {
            let rename_callback = rename_callback.clone();
            let rename_thread_id = rename_thread_id.clone();
            let archive_callback = archive_callback.clone();
            let archive_thread_id = archive_thread_id.clone();
            menu.min_w(px(228.))
                .item(
                    PopupMenuItem::new("Rename")
                        .icon(IconName::Replace)
                        .on_click(move |_, window, cx| {
                            if let Some(callback) = rename_callback.clone() {
                                callback(
                                    ShellAction::RenameThread(rename_thread_id.clone()),
                                    window,
                                    cx,
                                );
                            }
                        }),
                )
                .item(
                    PopupMenuItem::new("Archive")
                        .icon(IconName::FolderClosed)
                        .on_click(move |_, window, cx| {
                            if let Some(callback) = archive_callback.clone() {
                                callback(
                                    ShellAction::ArchiveThread(archive_thread_id.clone()),
                                    window,
                                    cx,
                                );
                            }
                        }),
                )
        })
        .into_any_element()
}

fn status_mark(status: ShellStatus, color: Hsla, theme: &EmmaTheme) -> AnyElement {
    let mark = match status {
        ShellStatus::Idle => "·",
        ShellStatus::Running => "◌",
        ShellStatus::Done => "✓",
        ShellStatus::Waiting => "●",
        ShellStatus::Failed => "!",
    };
    div()
        .flex_none()
        .size(px(12.))
        .items_center()
        .justify_center()
        .text_color(color)
        .text_size(theme.typography.fs_xs)
        .child(mark)
        .into_any_element()
}

fn status_color(status: ShellStatus, accent: Option<Hsla>, theme: &EmmaTheme) -> Hsla {
    accent.unwrap_or(match status {
        ShellStatus::Idle => theme.colors.text_3,
        ShellStatus::Running => theme.colors.teal,
        ShellStatus::Done => theme.colors.lime,
        ShellStatus::Waiting => theme.colors.orange,
        ShellStatus::Failed => theme.colors.danger,
    })
}

#[allow(clippy::too_many_arguments)]
fn render_icon_button(
    id: impl Into<ElementId>,
    icon: IconName,
    label: impl Into<SharedString>,
    action: ShellAction,
    foreground: Hsla,
    background: Hsla,
    hover: Hsla,
    active: Hsla,
    callback: &Option<ShellCallback>,
    cx: &mut App,
) -> Button {
    let label = label.into();
    let button = styled_button(
        id,
        background,
        foreground,
        hover,
        active,
        &EmmaTheme::global(cx).cloned().unwrap_or_default(),
        cx,
    )
    .size(px(28.))
    .rounded(px(6.))
    .icon(Icon::new(icon).size(px(14.)).text_color(foreground))
    .accessibility_label(label.clone())
    .tooltip(label)
    .tab_index(0);
    add_action(button, action, callback)
}

fn styled_button(
    id: impl Into<ElementId>,
    background: Hsla,
    foreground: Hsla,
    hover: Hsla,
    active: Hsla,
    theme: &EmmaTheme,
    cx: &mut App,
) -> Button {
    Button::new(id)
        .custom(
            ButtonCustomVariant::new(cx)
                .color(background)
                .foreground(foreground)
                .hover(hover)
                .active(active)
                .shadow(false),
        )
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_sm)
        .font_normal()
}

fn add_action(mut button: Button, action: ShellAction, callback: &Option<ShellCallback>) -> Button {
    if let Some(callback) = callback.clone() {
        button = button.on_click(move |_, window, cx| {
            callback(action.clone(), window, cx);
        });
    }
    button
}

fn render_sidebar_toggle(
    collapsed: bool,
    callback: &Option<ShellCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let colors = theme.colors;
    let surface_3 = colors.text.alpha(0.102);
    let surface_4 = colors.text.alpha(0.161);
    let button = render_icon_button(
        "shell-sidebar-toggle",
        if collapsed {
            IconName::PanelLeftOpen
        } else {
            IconName::PanelLeftClose
        },
        if collapsed {
            "Expand navigation"
        } else {
            "Collapse navigation"
        },
        ShellAction::ToggleSidebar,
        colors.text_2,
        transparent(colors),
        surface_3,
        surface_4,
        callback,
        cx,
    )
    .toggled(!collapsed);
    div()
        .id("shell-sidebar-toggle-reveal")
        .group("shell-sidebar-toggle-reveal")
        .absolute()
        .top(px(9.))
        .left(if collapsed { px(9.) } else { px(80.) })
        .size(px(28.))
        .child(if collapsed {
            button.into_any_element()
        } else {
            button
                .opacity(0.)
                .group_hover("shell-sidebar-toggle-reveal", |style| style.opacity(1.))
                .focus_visible(|style| style.opacity(1.))
                .into_any_element()
        })
        .into_any_element()
}

fn render_resize_handle(
    pane: ShellPane,
    right: bool,
    callback: &Option<ShellCallback>,
    theme: &EmmaTheme,
) -> impl IntoElement {
    let colors = theme.colors;
    let id = match pane {
        ShellPane::Sidebar => "shell-sidebar-resize",
        ShellPane::Inspector => "shell-inspector-resize",
        ShellPane::Browser => "shell-browser-resize",
        ShellPane::Terminal => "shell-terminal-resize",
    };
    let label = match pane {
        ShellPane::Sidebar => "Resize navigation",
        ShellPane::Inspector => "Resize inspector",
        ShellPane::Browser => "Resize browser",
        ShellPane::Terminal => "Resize terminal",
    };
    let mut handle = div()
        .id(id)
        .absolute()
        .top_0()
        .h_full()
        .w(px(8.))
        .when(right, |this| this.right(px(-4.)))
        .when(!right, |this| this.left(px(-4.)))
        .cursor_col_resize()
        .bg(colors.border.opacity(0.12))
        .hover(|style| style.bg(colors.text_3.opacity(0.7)))
        .focus_visible(|style| style.bg(colors.accent))
        .role(Role::Splitter)
        .aria_label(label)
        .aria_orientation(Orientation::Vertical)
        .tab_index(0);
    if let Some(callback) = callback.clone() {
        let keyboard_callback = callback.clone();
        handle = handle.on_mouse_down(MouseButton::Left, move |_, window, cx| {
            callback(ShellAction::BeginResize(pane), window, cx);
        });
        handle = handle.on_key_down(move |event, window, cx| {
            let delta = match event.keystroke.key.as_str() {
                "left" => Some(if right { -8 } else { 8 }),
                "right" => Some(if right { 8 } else { -8 }),
                _ => None,
            };
            if let Some(delta) = delta {
                keyboard_callback(ShellAction::ResizeBy(pane, delta), window, cx);
            }
        });
    }
    handle
}

fn render_terminal(
    terminal: AnyElement,
    height: Pixels,
    callback: &Option<ShellCallback>,
    theme: &EmmaTheme,
) -> impl IntoElement {
    v_flex()
        .id("shell-terminal")
        .relative()
        .h(height)
        .min_h(px(120.))
        .max_h(px(720.))
        .flex_none()
        .border_t_1()
        .border_color(theme.colors.border)
        .child(render_terminal_resize_handle(callback, theme))
        .child(terminal)
}

fn render_browser(
    browser: AnyElement,
    width: Pixels,
    callback: &Option<ShellCallback>,
    theme: &EmmaTheme,
) -> impl IntoElement {
    v_flex()
        .id("shell-browser")
        .relative()
        .h_full()
        .w(width)
        .flex_none()
        .min_h_0()
        .bg(theme.colors.chrome)
        .child(browser)
        .child(render_resize_handle(
            ShellPane::Browser,
            false,
            callback,
            theme,
        ))
}

fn render_terminal_resize_handle(
    callback: &Option<ShellCallback>,
    theme: &EmmaTheme,
) -> impl IntoElement {
    let mut handle = div()
        .id("shell-terminal-resize")
        .absolute()
        .top(px(-4.))
        .left_0()
        .right_0()
        .h(px(8.))
        .cursor_row_resize()
        .bg(theme.colors.border.opacity(0.12))
        .hover(|style| style.bg(theme.colors.text_3.opacity(0.7)))
        .focus_visible(|style| style.bg(theme.colors.accent))
        .role(Role::Splitter)
        .aria_label("Resize terminal")
        .aria_orientation(Orientation::Horizontal)
        .tab_index(0);
    if let Some(callback) = callback.clone() {
        let keyboard_callback = callback.clone();
        handle = handle.on_mouse_down(MouseButton::Left, move |_, window, cx| {
            callback(ShellAction::BeginResize(ShellPane::Terminal), window, cx);
        });
        handle = handle.on_key_down(move |event, window, cx| {
            let delta = match event.keystroke.key.as_str() {
                "up" => Some(8),
                "down" => Some(-8),
                _ => None,
            };
            if let Some(delta) = delta {
                keyboard_callback(
                    ShellAction::ResizeBy(ShellPane::Terminal, delta),
                    window,
                    cx,
                );
            }
        });
    }
    handle
}

fn render_inspector(
    title: SharedString,
    selected_tab: InspectorTab,
    body: Option<AnyElement>,
    callback: &Option<ShellCallback>,
    theme: &EmmaTheme,
    inspector_width: Pixels,
    cx: &mut App,
) -> impl IntoElement {
    let colors = theme.colors;
    let spacing = theme.spacing;
    let surface_2 = colors.text.alpha(0.0588);
    let surface_3 = colors.text.alpha(0.102);
    let mut header = h_flex()
        .flex_none()
        .h(theme.dimensions.inspector_header_height)
        .px(spacing.s4)
        .gap(px(2.))
        .border_b_1()
        .border_color(colors.border);
    header = header.child(
        div()
            .flex_1()
            .min_w_0()
            .truncate()
            .text_color(colors.text_2)
            .text_size(theme.typography.fs_2xs)
            .child(title),
    );
    for tab in InspectorTab::ALL {
        let selected = selected_tab == tab;
        let mut button = styled_button(
            format!("shell-inspector-tab-{}", tab.id()),
            if selected {
                colors.accent_soft
            } else {
                transparent(colors)
            },
            if selected { colors.text } else { colors.text_3 },
            surface_2,
            surface_3,
            theme,
            cx,
        )
        .h(theme.dimensions.inspector_header_height)
        .px(spacing.s2)
        .rounded(px(0.))
        .label(tab.label())
        .selected(selected)
        .toggled(selected)
        .accessibility_label(tab.label());
        button = add_action(button, ShellAction::SelectInspectorTab(tab), callback);
        header = header.child(button);
    }
    let body = body.unwrap_or_else(|| div().into_any_element());
    v_flex()
        .relative()
        .h_full()
        .w(inspector_width)
        .flex_none()
        .min_h_0()
        .bg(colors.chrome)
        .border_l_1()
        .border_color(colors.border_strong)
        .child(header)
        .child(
            v_flex()
                .id("shell-inspector-body")
                .flex_1()
                .min_h_0()
                .overflow_y_scroll()
                .p(spacing.s4)
                .child(body),
        )
        .child(render_resize_handle(
            ShellPane::Inspector,
            false,
            callback,
            theme,
        ))
}

fn transparent(colors: crate::theme::EmmaColors) -> Hsla {
    colors.text.alpha(0.)
}

fn mode_icon(mode: WorkspaceMode) -> IconName {
    match mode {
        WorkspaceMode::Threads => IconName::Inbox,
        WorkspaceMode::Knowledge => IconName::BookOpen,
        WorkspaceMode::Artifacts => IconName::FileText,
        WorkspaceMode::Agent => IconName::Bot,
        WorkspaceMode::Scheduled => IconName::Calendar,
        WorkspaceMode::Plugins => IconName::Network,
        WorkspaceMode::Research => IconName::ChartPie,
        WorkspaceMode::Archive => IconName::FolderClosed,
        WorkspaceMode::Settings => IconName::Settings,
    }
}

fn nav_color(mode: WorkspaceMode, theme: &EmmaTheme) -> Hsla {
    match mode {
        WorkspaceMode::Threads => theme.colors.blue,
        WorkspaceMode::Knowledge => theme.colors.teal,
        WorkspaceMode::Scheduled => theme.colors.violet,
        WorkspaceMode::Agent => theme.colors.lime,
        _ => theme.colors.text_3,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pane_widths_use_defaults_and_renderer_bounds() {
        assert_eq!(bounded_width(None, px(260.), px(200.), px(340.)), px(260.));
        assert_eq!(
            bounded_width(Some(px(180.)), px(260.), px(200.), px(340.)),
            px(200.)
        );
        assert_eq!(
            bounded_width(Some(px(390.)), px(260.), px(200.), px(340.)),
            px(340.)
        );
        assert_eq!(
            bounded_width(Some(px(280.)), px(288.), px(260.), px(360.)),
            px(280.)
        );
        assert_eq!(
            bounded_width(Some(px(200.)), px(420.), px(260.), px(720.)),
            px(260.)
        );
        assert_eq!(
            bounded_width(Some(px(900.)), px(420.), px(260.), px(720.)),
            px(720.)
        );
    }

    #[test]
    fn thread_actions_keep_the_selected_thread_id() {
        let id: SharedString = "thread-1".into();
        assert_eq!(
            ShellAction::ArchiveThread(id.clone()),
            ShellAction::ArchiveThread("thread-1".into())
        );
        assert_eq!(
            ShellAction::RenameThread(id),
            ShellAction::RenameThread("thread-1".into())
        );
    }

    #[test]
    fn more_navigation_has_a_distinct_element_id() {
        assert_ne!(nav_button_id(WorkspaceMode::Settings), "shell-nav-more");
    }
}
