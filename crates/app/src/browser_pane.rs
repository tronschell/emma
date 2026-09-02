use std::rc::Rc;

use gpui::{
    AnyElement, App, Entity, InteractiveElement as _, IntoElement, ParentElement as _, RenderOnce,
    SharedString, StatefulInteractiveElement as _, Styled as _, Window, accesskit::Role, div, px,
    relative,
};
use gpui_component::{
    Disableable as _, Selectable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Input, InputState},
    v_flex,
};

use crate::{
    browser_surface::{
        BrowserStatus, BrowserTab, ExternalLinkDecision, Navigation, PopupDecision, SecurityError,
        SurfaceKind, download_decision, external_link_decision, normalize_navigation_url,
        popup_decision,
    },
    theme::EmmaTheme,
};

pub const BROWSER_TABS_HEIGHT: f32 = 38.;
pub const BROWSER_BAR_HEIGHT: f32 = 36.;
pub const BROWSER_ADDRESS_HEIGHT: f32 = 30.;
pub const BROWSER_ICON_SIZE: f32 = 26.;
pub const BROWSER_TAB_HEIGHT: f32 = 28.;
pub const BROWSER_TAB_MAX_WIDTH: f32 = 200.;
pub const BROWSER_CLIPS_MAX_FRACTION: f32 = 0.38;
pub const PIP_TABS_HEIGHT: f32 = 30.;
pub const PIP_BAR_HEIGHT: f32 = 30.;
pub const PIP_ADDRESS_HEIGHT: f32 = 26.;
pub const PIP_ICON_SIZE: f32 = 22.;
pub const VISUAL_MIN_HEIGHT: u32 = 120;
pub const VISUAL_MAX_HEIGHT: u32 = 760;
pub const VISUAL_DEFAULT_WIDTH: u32 = 720;
pub const COMPONENT_REVEAL_CHARS: usize = 900;
pub const MAX_PICK_LABEL_BYTES: usize = 512;
pub const MAX_PICK_HTML_BYTES: usize = 8 * 1024;
pub const MAX_CLIPS: usize = 64;
pub const MAX_CLIP_BYTES: usize = 8 * 1024;

pub type BrowserPaneCallback = Rc<dyn Fn(BrowserPaneAction, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum BrowserPaneKind {
    #[default]
    Browser,
    Component,
    Artifact,
    Visual,
}

impl BrowserPaneKind {
    pub const fn surface(self) -> SurfaceKind {
        match self {
            Self::Browser => SurfaceKind::Browser,
            Self::Component => SurfaceKind::Component,
            Self::Artifact => SurfaceKind::Artifact,
            Self::Visual => SurfaceKind::Visual,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Browser => "Browser",
            Self::Component => "Component",
            Self::Artifact => "Artifact",
            Self::Visual => "Visual",
        }
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum PaneFrameState {
    #[default]
    Empty,
    Loading,
    Ready,
    Error(String),
}

impl PaneFrameState {
    pub const fn is_error(&self) -> bool {
        matches!(self, Self::Error(_))
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum AddressState {
    #[default]
    Viewing,
    Editing {
        draft: String,
    },
}

impl AddressState {
    pub fn draft(&self) -> Option<&str> {
        match self {
            Self::Viewing => None,
            Self::Editing { draft } => Some(draft),
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ComponentChromeState {
    pub id: String,
    pub title: String,
    pub expands: bool,
    pub expanded: bool,
    pub menu_open: bool,
    pub loading: bool,
    pub revealing: bool,
    pub screenshot_sent: bool,
    pub error: Option<String>,
}

impl ComponentChromeState {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            expands: false,
            expanded: false,
            menu_open: false,
            loading: true,
            revealing: false,
            screenshot_sent: false,
            error: None,
        }
    }

    pub fn open(&self) -> bool {
        self.expands && self.expanded
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ArtifactChromeState {
    pub id: String,
    pub title: String,
    pub loading: bool,
    pub error: Option<String>,
}

impl ArtifactChromeState {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            loading: true,
            error: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VisualChromeState {
    pub id: String,
    pub title: String,
    pub height: u32,
    pub picking: bool,
    pub loading: bool,
    pub exporting: bool,
    pub keeping: bool,
    pub note: Option<String>,
    pub picked_label: Option<String>,
    pub picked_html: Option<String>,
    pub error: Option<String>,
}

impl VisualChromeState {
    pub fn new(id: impl Into<String>, title: impl Into<String>) -> Self {
        Self {
            id: id.into(),
            title: title.into(),
            height: VISUAL_MIN_HEIGHT,
            picking: false,
            loading: true,
            exporting: false,
            keeping: false,
            note: None,
            picked_label: None,
            picked_html: None,
            error: None,
        }
    }

    pub fn set_height(&mut self, height: u32) {
        self.height = height.clamp(VISUAL_MIN_HEIGHT, VISUAL_MAX_HEIGHT);
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct BrowserPaneState {
    pub kind: BrowserPaneKind,
    pub status: BrowserStatus,
    pub frame: PaneFrameState,
    pub address: AddressState,
    pub clips: Option<Vec<String>>,
    pub visible: bool,
    pub floating: bool,
    pub wide: bool,
    pub component: Option<ComponentChromeState>,
    pub artifact: Option<ArtifactChromeState>,
    pub visual: Option<VisualChromeState>,
}

impl Default for BrowserPaneState {
    fn default() -> Self {
        Self::new(BrowserPaneKind::Browser)
    }
}

impl BrowserPaneState {
    pub fn new(kind: BrowserPaneKind) -> Self {
        let status = blank_status();
        Self {
            kind,
            status,
            frame: PaneFrameState::Empty,
            address: AddressState::Viewing,
            clips: None,
            visible: false,
            floating: false,
            wide: false,
            component: (kind == BrowserPaneKind::Component)
                .then(|| ComponentChromeState::new("", "Component")),
            artifact: (kind == BrowserPaneKind::Artifact)
                .then(|| ArtifactChromeState::new("", "Artifact")),
            visual: (kind == BrowserPaneKind::Visual).then(|| VisualChromeState::new("", "Visual")),
        }
    }

    pub fn from_status(kind: BrowserPaneKind, status: BrowserStatus) -> Self {
        let mut state = Self::new(kind);
        state.set_status(status);
        state
    }

    pub fn with_component(mut self, component: ComponentChromeState) -> Self {
        self.component = Some(component);
        self
    }

    pub fn with_artifact(mut self, artifact: ArtifactChromeState) -> Self {
        self.artifact = Some(artifact);
        self
    }

    pub fn with_visual(mut self, visual: VisualChromeState) -> Self {
        self.visual = Some(visual);
        self
    }

    pub fn with_frame(mut self, frame: PaneFrameState) -> Self {
        self.frame = frame;
        self
    }

    pub fn active_tab(&self) -> Option<&BrowserTab> {
        self.status
            .active_tab
            .as_deref()
            .and_then(|id| self.status.tabs.iter().find(|tab| tab.id == id))
            .or_else(|| self.status.tabs.first())
    }

    pub fn set_status(&mut self, status: BrowserStatus) {
        self.status = status;
        self.visible = self.status.running;
        if self.status.loading {
            self.frame = PaneFrameState::Loading;
        } else if !self.status.running {
            self.frame = PaneFrameState::Empty;
        } else if !self.frame.is_error() {
            self.frame = PaneFrameState::Ready;
        }
    }

    pub fn set_clips(&mut self, clips: Option<Vec<String>>) {
        self.clips = clips.map(bounded_clips);
    }

    pub fn set_frame(&mut self, frame: PaneFrameState) {
        self.frame = frame;
    }

    pub fn set_error(&mut self, error: impl Into<String>) {
        self.frame = PaneFrameState::Error(error.into());
    }

    pub fn reduce(&mut self, action: BrowserPaneAction) -> Option<BrowserPaneEffect> {
        match action {
            BrowserPaneAction::SetStatus(status) => {
                self.set_status(status);
                None
            }
            BrowserPaneAction::SetFrame(frame) => {
                self.set_frame(frame);
                None
            }
            BrowserPaneAction::SetClips(clips) => {
                self.clips = Some(bounded_clips(clips));
                None
            }
            BrowserPaneAction::SelectTab(tab_id) => {
                if self.status.tabs.iter().any(|tab| tab.id == tab_id) {
                    self.status.active_tab = Some(tab_id.clone());
                    self.status_from_active();
                    Some(BrowserPaneEffect::SelectTab(tab_id))
                } else {
                    Some(BrowserPaneEffect::Blocked(SecurityError::InvalidUrl))
                }
            }
            BrowserPaneAction::NewTab => Some(BrowserPaneEffect::NewTab),
            BrowserPaneAction::CloseTab(tab_id) => {
                let Some(index) = self.status.tabs.iter().position(|tab| tab.id == tab_id) else {
                    return Some(BrowserPaneEffect::Blocked(SecurityError::InvalidUrl));
                };
                self.status.tabs.remove(index);
                if self.status.active_tab.as_deref() == Some(tab_id.as_str()) {
                    self.status.active_tab = self
                        .status
                        .tabs
                        .get(index.min(self.status.tabs.len().saturating_sub(1)))
                        .or_else(|| self.status.tabs.first())
                        .map(|tab| tab.id.clone());
                }
                self.status_from_active();
                Some(BrowserPaneEffect::CloseTab(tab_id))
            }
            BrowserPaneAction::BeginAddressEdit => {
                let draft = self
                    .active_tab()
                    .map_or_else(String::new, |tab| tab.url.clone());
                self.address = AddressState::Editing { draft };
                None
            }
            BrowserPaneAction::SetAddress(draft) => {
                if let AddressState::Editing { draft: current } = &mut self.address {
                    *current =
                        bounded_text(&draft, crate::browser_surface::MAX_NAVIGATION_URL_BYTES);
                }
                None
            }
            BrowserPaneAction::SubmitAddress => {
                let AddressState::Editing { draft } = std::mem::take(&mut self.address) else {
                    return None;
                };
                let draft = draft.trim();
                if draft.is_empty() {
                    self.address = AddressState::Viewing;
                    return None;
                }
                let candidate = address_candidate(draft);
                Some(BrowserPaneEffect::AddressSubmitted(candidate))
            }
            BrowserPaneAction::CancelAddress => {
                self.address = AddressState::Viewing;
                None
            }
            BrowserPaneAction::Back => self.navigation(Navigation::Back),
            BrowserPaneAction::Forward => self.navigation(Navigation::Forward),
            BrowserPaneAction::Reload => self.navigation(Navigation::Reload),
            BrowserPaneAction::ToggleClipboard => {
                if self.clips.is_some() {
                    self.clips = None;
                    None
                } else {
                    self.clips = Some(Vec::new());
                    Some(BrowserPaneEffect::ClipboardRequested)
                }
            }
            BrowserPaneAction::UseClipboard(index) => {
                if self.clips.as_ref().is_some_and(|clips| index < clips.len()) {
                    self.clips = None;
                    Some(BrowserPaneEffect::ClipboardUse(index))
                } else {
                    Some(BrowserPaneEffect::Blocked(SecurityError::MessageInvalid))
                }
            }
            BrowserPaneAction::Float(floating) => {
                self.floating = floating;
                Some(BrowserPaneEffect::Float(floating))
            }
            BrowserPaneAction::ToggleFloat => {
                self.floating = !self.floating;
                Some(BrowserPaneEffect::Float(self.floating))
            }
            BrowserPaneAction::Wide(wide) => {
                self.wide = wide;
                Some(BrowserPaneEffect::Wide(wide))
            }
            BrowserPaneAction::ToggleWide => {
                self.wide = !self.wide;
                Some(BrowserPaneEffect::Wide(self.wide))
            }
            BrowserPaneAction::Hide => {
                self.visible = false;
                Some(BrowserPaneEffect::Hide)
            }
            BrowserPaneAction::Close => {
                self.visible = false;
                Some(BrowserPaneEffect::Close)
            }
            BrowserPaneAction::OpenExternal => {
                let Some(url) = self.active_tab().map(|tab| tab.url.as_str()) else {
                    return Some(BrowserPaneEffect::Blocked(SecurityError::EmptyUrl));
                };
                match external_link_decision(url) {
                    ExternalLinkDecision::OpenExternal(url) => {
                        Some(BrowserPaneEffect::OpenExternal(url))
                    }
                    ExternalLinkDecision::Block(error) => Some(BrowserPaneEffect::Blocked(error)),
                }
            }
            BrowserPaneAction::Popup(url) => match popup_decision(&url) {
                PopupDecision::NewTab(url) => Some(BrowserPaneEffect::PopupNewTab(url)),
                PopupDecision::OpenExternal(url) => Some(BrowserPaneEffect::OpenExternal(url)),
                PopupDecision::Block(error) => Some(BrowserPaneEffect::Blocked(error)),
            },
            BrowserPaneAction::Download(url) => match download_decision(&url) {
                crate::browser_surface::DownloadDecision::OpenExternal(url) => {
                    Some(BrowserPaneEffect::Download(url))
                }
                crate::browser_surface::DownloadDecision::Block(error) => {
                    Some(BrowserPaneEffect::Blocked(error))
                }
            },
            BrowserPaneAction::NavigationBlocked(error) => {
                self.frame = PaneFrameState::Error(error.to_string());
                Some(BrowserPaneEffect::Blocked(error))
            }
            BrowserPaneAction::Retry => {
                self.frame = PaneFrameState::Loading;
                Some(BrowserPaneEffect::Retry)
            }
            BrowserPaneAction::ComponentLoaded => {
                if let Some(component) = self.component.as_mut() {
                    component.loading = false;
                    component.revealing = true;
                    component.error = None;
                }
                self.frame = PaneFrameState::Ready;
                None
            }
            BrowserPaneAction::ComponentRevealFinished => {
                if let Some(component) = self.component.as_mut() {
                    component.revealing = false;
                }
                None
            }
            BrowserPaneAction::ComponentError(error) => {
                if let Some(component) = self.component.as_mut() {
                    component.loading = false;
                    component.revealing = false;
                    component.error = Some(error.clone());
                }
                self.frame = PaneFrameState::Error(error);
                None
            }
            BrowserPaneAction::ComponentMenu(open) => {
                if let Some(component) = self.component.as_mut() {
                    component.menu_open = open;
                }
                None
            }
            BrowserPaneAction::ComponentExpand(expanded) => {
                let component = self.component.as_mut()?;
                if !component.expands {
                    return Some(BrowserPaneEffect::Blocked(
                        SecurityError::CapabilityNotAllowed,
                    ));
                }
                component.expanded = expanded;
                component.menu_open = false;
                Some(BrowserPaneEffect::Component(
                    ComponentPaneEffect::SetExpanded(expanded),
                ))
            }
            BrowserPaneAction::ComponentAllowFullscreen(expands) => {
                if let Some(component) = self.component.as_mut() {
                    component.expands = expands;
                    if !expands {
                        component.expanded = false;
                    }
                    component.menu_open = false;
                }
                Some(BrowserPaneEffect::Component(
                    ComponentPaneEffect::AllowFullscreen(expands),
                ))
            }
            BrowserPaneAction::ComponentSwitchOff => {
                if let Some(component) = self.component.as_mut() {
                    component.menu_open = false;
                }
                Some(BrowserPaneEffect::Component(ComponentPaneEffect::SwitchOff))
            }
            BrowserPaneAction::ComponentDelete => {
                if let Some(component) = self.component.as_mut() {
                    component.menu_open = false;
                }
                Some(BrowserPaneEffect::Component(ComponentPaneEffect::Delete))
            }
            BrowserPaneAction::ComponentCloseFullscreen => {
                if let Some(component) = self.component.as_mut() {
                    component.expanded = false;
                }
                Some(BrowserPaneEffect::Component(
                    ComponentPaneEffect::CloseFullscreen,
                ))
            }
            BrowserPaneAction::ComponentScreenshot => {
                let component = self.component.as_mut()?;
                if component.id.is_empty() || component.screenshot_sent {
                    return None;
                }
                component.screenshot_sent = true;
                Some(BrowserPaneEffect::Component(
                    ComponentPaneEffect::Screenshot {
                        id: component.id.clone(),
                    },
                ))
            }
            BrowserPaneAction::ArtifactLoaded => {
                if let Some(artifact) = self.artifact.as_mut() {
                    artifact.loading = false;
                    artifact.error = None;
                }
                self.frame = PaneFrameState::Ready;
                None
            }
            BrowserPaneAction::ArtifactError(error) => {
                if let Some(artifact) = self.artifact.as_mut() {
                    artifact.loading = false;
                    artifact.error = Some(error.clone());
                }
                self.frame = PaneFrameState::Error(error);
                None
            }
            BrowserPaneAction::VisualLoaded => {
                if let Some(visual) = self.visual.as_mut() {
                    visual.loading = false;
                    visual.error = None;
                }
                self.frame = PaneFrameState::Ready;
                None
            }
            BrowserPaneAction::VisualError(error) => {
                if let Some(visual) = self.visual.as_mut() {
                    visual.loading = false;
                    visual.error = Some(error.clone());
                }
                self.frame = PaneFrameState::Error(error);
                None
            }
            BrowserPaneAction::VisualPick(picking) => {
                if let Some(visual) = self.visual.as_mut() {
                    visual.picking = picking;
                    visual.note = picking.then(|| {
                        "Point at a part of the picture to attach it to your next message."
                            .to_owned()
                    });
                }
                Some(BrowserPaneEffect::Visual(VisualPaneEffect::SetPicking(
                    picking,
                )))
            }
            BrowserPaneAction::VisualMeasure(height) => {
                if let Some(visual) = self.visual.as_mut() {
                    visual.set_height(height);
                }
                None
            }
            BrowserPaneAction::VisualPicked { label, html } => {
                let label = bounded_text(&label, MAX_PICK_LABEL_BYTES);
                let html = bounded_text(&html, MAX_PICK_HTML_BYTES);
                if label.is_empty() || html.is_empty() {
                    return Some(BrowserPaneEffect::Blocked(SecurityError::MessageInvalid));
                }
                if let Some(visual) = self.visual.as_mut() {
                    visual.picking = false;
                    visual.note = Some(format!("{label} is attached to your next message."));
                    visual.picked_label = Some(label.clone());
                    visual.picked_html = Some(html.clone());
                }
                Some(BrowserPaneEffect::Visual(VisualPaneEffect::Picked {
                    label,
                    html,
                }))
            }
            BrowserPaneAction::VisualExport => {
                let id = self
                    .visual
                    .as_ref()
                    .map(|visual| visual.id.clone())
                    .unwrap_or_default();
                if id.is_empty() {
                    return Some(BrowserPaneEffect::Blocked(SecurityError::HostNotAllowed));
                }
                if let Some(visual) = self.visual.as_mut() {
                    visual.exporting = true;
                }
                Some(BrowserPaneEffect::Visual(VisualPaneEffect::Export {
                    id,
                    width: VISUAL_DEFAULT_WIDTH,
                }))
            }
            BrowserPaneAction::VisualKeep => {
                let id = self
                    .visual
                    .as_ref()
                    .map(|visual| visual.id.clone())
                    .unwrap_or_default();
                if id.is_empty() {
                    return Some(BrowserPaneEffect::Blocked(SecurityError::HostNotAllowed));
                }
                if let Some(visual) = self.visual.as_mut() {
                    visual.keeping = true;
                }
                Some(BrowserPaneEffect::Visual(VisualPaneEffect::Keep { id }))
            }
            BrowserPaneAction::VisualBusy(exporting, keeping) => {
                if let Some(visual) = self.visual.as_mut() {
                    visual.exporting = exporting;
                    visual.keeping = keeping;
                }
                None
            }
            BrowserPaneAction::VisualNote(note) => {
                if let Some(visual) = self.visual.as_mut() {
                    visual.note = (!note.is_empty()).then_some(note);
                }
                None
            }
        }
    }

    fn navigation(&mut self, navigation: Navigation) -> Option<BrowserPaneEffect> {
        if !self.status.running {
            return None;
        }
        let allowed = match navigation {
            Navigation::Back => self.status.can_go_back,
            Navigation::Forward => self.status.can_go_forward,
            Navigation::Reload => true,
            Navigation::Close => false,
        };
        allowed.then_some(BrowserPaneEffect::Navigate(navigation))
    }

    fn status_from_active(&mut self) {
        let active = self.active_tab().map(|tab| {
            (
                tab.url.clone(),
                (!tab.title.trim().is_empty()).then(|| tab.title.trim().to_owned()),
                tab.loading,
                tab.can_go_back,
                tab.can_go_forward,
            )
        });
        self.status.running = !self.status.tabs.is_empty();
        self.status.url = active.as_ref().map(|active| active.0.clone());
        self.status.title = active.as_ref().and_then(|active| active.1.clone());
        self.status.loading = active.as_ref().is_some_and(|active| active.2);
        self.status.can_go_back = active.as_ref().is_some_and(|active| active.3);
        self.status.can_go_forward = active.as_ref().is_some_and(|active| active.4);
        self.visible = self.status.running;
        self.frame = if !self.status.running {
            PaneFrameState::Empty
        } else if self.status.loading {
            PaneFrameState::Loading
        } else if self.frame.is_error() {
            self.frame.clone()
        } else {
            PaneFrameState::Ready
        };
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum BrowserPaneAction {
    SetStatus(BrowserStatus),
    SetFrame(PaneFrameState),
    SetClips(Vec<String>),
    SelectTab(String),
    NewTab,
    CloseTab(String),
    BeginAddressEdit,
    SetAddress(String),
    SubmitAddress,
    CancelAddress,
    Back,
    Forward,
    Reload,
    ToggleClipboard,
    UseClipboard(usize),
    Float(bool),
    ToggleFloat,
    Wide(bool),
    ToggleWide,
    Hide,
    Close,
    OpenExternal,
    Popup(String),
    Download(String),
    NavigationBlocked(SecurityError),
    Retry,
    ComponentLoaded,
    ComponentRevealFinished,
    ComponentError(String),
    ComponentMenu(bool),
    ComponentExpand(bool),
    ComponentAllowFullscreen(bool),
    ComponentSwitchOff,
    ComponentDelete,
    ComponentCloseFullscreen,
    ComponentScreenshot,
    ArtifactLoaded,
    ArtifactError(String),
    VisualLoaded,
    VisualError(String),
    VisualPick(bool),
    VisualMeasure(u32),
    VisualPicked { label: String, html: String },
    VisualExport,
    VisualKeep,
    VisualBusy(bool, bool),
    VisualNote(String),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ComponentPaneEffect {
    SetExpanded(bool),
    AllowFullscreen(bool),
    SwitchOff,
    Delete,
    CloseFullscreen,
    Screenshot { id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VisualPaneEffect {
    SetPicking(bool),
    Picked { label: String, html: String },
    Export { id: String, width: u32 },
    Keep { id: String },
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BrowserPaneEffect {
    SelectTab(String),
    NewTab,
    CloseTab(String),
    Navigate(Navigation),
    AddressSubmitted(String),
    ClipboardRequested,
    ClipboardUse(usize),
    Float(bool),
    Wide(bool),
    Hide,
    Close,
    OpenExternal(String),
    PopupNewTab(String),
    Download(String),
    Blocked(SecurityError),
    Retry,
    Component(ComponentPaneEffect),
    Visual(VisualPaneEffect),
}

#[derive(IntoElement)]
pub struct BrowserPaneView {
    state: BrowserPaneState,
    frame: Option<AnyElement>,
    address_input: Option<Entity<InputState>>,
    address_value: Option<SharedString>,
    pip: bool,
    callback: Option<BrowserPaneCallback>,
}

impl BrowserPaneView {
    pub fn new(state: BrowserPaneState) -> Self {
        Self {
            state,
            frame: None,
            address_input: None,
            address_value: None,
            pip: false,
            callback: None,
        }
    }

    pub fn frame(mut self, frame: impl IntoElement) -> Self {
        self.frame = Some(frame.into_any_element());
        self
    }

    pub fn address_input(mut self, state: Entity<InputState>) -> Self {
        self.address_input = Some(state);
        self
    }

    pub fn address_value(mut self, value: impl Into<SharedString>) -> Self {
        self.address_value = Some(value.into());
        self
    }

    pub fn pip(mut self, pip: bool) -> Self {
        self.pip = pip;
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(BrowserPaneAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for BrowserPaneView {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        match self.state.kind {
            BrowserPaneKind::Browser => render_browser(self, &theme, cx),
            BrowserPaneKind::Component => render_component(self, &theme, cx),
            BrowserPaneKind::Artifact => render_artifact(self, &theme, cx),
            BrowserPaneKind::Visual => render_visual(self, &theme, cx),
        }
    }
}

fn render_browser(mut pane: BrowserPaneView, theme: &EmmaTheme, _cx: &mut App) -> AnyElement {
    let colors = theme.colors;
    let spacing = theme.spacing;
    let status = pane.state.status.clone();
    let callback = pane.callback.clone();
    let pip = pane.pip;
    let icon_size = if pip {
        px(PIP_ICON_SIZE)
    } else {
        px(BROWSER_ICON_SIZE)
    };
    let tabs_height = if pip {
        px(PIP_TABS_HEIGHT)
    } else {
        px(BROWSER_TABS_HEIGHT)
    };
    let bar_height = if pip {
        px(PIP_BAR_HEIGHT)
    } else {
        px(BROWSER_BAR_HEIGHT)
    };
    let address_height = if pip {
        px(PIP_ADDRESS_HEIGHT)
    } else {
        px(BROWSER_ADDRESS_HEIGHT)
    };
    let mut strip = h_flex()
        .id("browser-tab-strip")
        .items_center()
        .gap(px(4.))
        .min_w_0()
        .flex_1()
        .overflow_x_scroll();
    for tab in status.tabs.clone() {
        let active = status.active_tab.as_deref() == Some(tab.id.as_str());
        let label = tab_name(&tab);
        let tab_id = tab.id.clone();
        let action = BrowserPaneAction::SelectTab(tab_id.clone());
        let mut tab_button = Button::new(format!("browser-tab-{tab_id}"))
            .ghost()
            .compact()
            .rounded(px(0.))
            .role(Role::Tab)
            .selected(active)
            .accessibility_label(format!("Open {label}"))
            .tooltip(tab.url.clone())
            .child(
                h_flex()
                    .items_center()
                    .gap(px(6.))
                    .min_w_0()
                    .child(div().size(px(14.)).child(if tab.favicon.is_some() {
                        "◉"
                    } else {
                        "○"
                    }))
                    .child(div().min_w_0().overflow_hidden().child(label.clone())),
            );
        if let Some(callback) = callback.clone() {
            tab_button = tab_button.on_click(move |_, window, cx| {
                callback(action.clone(), window, cx);
            });
        }
        let close_action = BrowserPaneAction::CloseTab(tab_id.clone());
        let close = pane_button(
            format!("browser-tab-close-{tab_id}"),
            "×",
            format!("Close {label}"),
            close_action,
            false,
            false,
            callback.clone(),
            theme,
            icon_size,
        );
        strip = strip.child(
            h_flex()
                .id(format!("browser-tab-shell-{tab_id}"))
                .items_center()
                .gap(px(2.))
                .min_w_0()
                .max_w(px(BROWSER_TAB_MAX_WIDTH))
                .h(px(if pip {
                    PIP_TABS_HEIGHT - 4.
                } else {
                    BROWSER_TAB_HEIGHT
                }))
                .bg(if active {
                    colors.surface_3
                } else {
                    colors.bg.alpha(0.)
                })
                .child(tab_button)
                .child(close),
        );
    }
    strip = strip.child(pane_button(
        "browser-new-tab",
        "+",
        "New tab",
        BrowserPaneAction::NewTab,
        false,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    let mut window_controls = h_flex().items_center().gap(px(4.)).flex_none();
    window_controls = window_controls.child(pane_button(
        "browser-float",
        "□",
        if pane.state.floating {
            "Dock the browser"
        } else {
            "Float the browser"
        },
        BrowserPaneAction::ToggleFloat,
        false,
        pane.state.floating,
        callback.clone(),
        theme,
        icon_size,
    ));
    window_controls = window_controls.child(pane_button(
        "browser-wide",
        "↔",
        if pane.state.wide {
            "Narrow the browser"
        } else {
            "Widen the browser"
        },
        BrowserPaneAction::ToggleWide,
        false,
        pane.state.wide,
        callback.clone(),
        theme,
        icon_size,
    ));
    window_controls = window_controls.child(pane_button(
        "browser-hide",
        "—",
        "Hide the browser",
        BrowserPaneAction::Hide,
        false,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    window_controls = window_controls.child(pane_button(
        "browser-close",
        "×",
        "Close the browser",
        BrowserPaneAction::Close,
        false,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    let tabs = h_flex()
        .id("browser-tabs")
        .items_center()
        .gap(spacing.s2)
        .h(tabs_height)
        .px(spacing.s2)
        .flex_none()
        .child(strip)
        .child(window_controls);

    let mut bar = h_flex()
        .id("browser-bar")
        .items_center()
        .gap(px(4.))
        .h(bar_height)
        .px(spacing.s2)
        .pb(spacing.s2)
        .flex_none();
    bar = bar.child(pane_button(
        "browser-back",
        "‹",
        "Back",
        BrowserPaneAction::Back,
        !status.can_go_back,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    bar = bar.child(pane_button(
        "browser-forward",
        "›",
        "Forward",
        BrowserPaneAction::Forward,
        !status.can_go_forward,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    bar = bar.child(pane_button(
        "browser-reload",
        "↻",
        "Reload",
        BrowserPaneAction::Reload,
        !status.running,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    let editing = pane.state.address.draft().is_some();
    let draft = pane
        .state
        .address
        .draft()
        .map(str::to_owned)
        .or_else(|| pane.address_value.as_ref().map(ToString::to_string))
        .unwrap_or_default();
    let address_label = status
        .url
        .as_deref()
        .map(host_name)
        .unwrap_or_else(|| "Open a page".to_owned());
    let address_callback = callback.clone();
    let input_state = pane.address_input.clone();
    let input_draft = draft.clone();
    let address = if editing {
        let key_callback = callback.clone();
        let key_input = input_state.clone();
        let mut field = h_flex()
            .id("browser-address-field")
            .items_center()
            .h(address_height)
            .flex_1()
            .min_w_0()
            .rounded(theme.radii.full)
            .bg(colors.surface_3)
            .on_key_down(
                move |event, window, cx| match event.keystroke.key.as_str() {
                    "enter" => {
                        window.prevent_default();
                        if let Some(callback) = key_callback.as_ref() {
                            let draft = key_input
                                .as_ref()
                                .map(|input| input.read(cx).value().to_string())
                                .unwrap_or_else(|| input_draft.clone());
                            callback(BrowserPaneAction::SetAddress(draft), window, cx);
                            callback(BrowserPaneAction::SubmitAddress, window, cx);
                        }
                    }
                    "escape" => {
                        window.prevent_default();
                        if let Some(callback) = key_callback.as_ref() {
                            callback(BrowserPaneAction::CancelAddress, window, cx);
                        }
                    }
                    _ => {}
                },
            );
        if let Some(state) = input_state {
            field = field.child(
                Input::new(&state)
                    .appearance(false)
                    .bordered(false)
                    .focus_bordered(true)
                    .h(address_height)
                    .w_full()
                    .min_w_0()
                    .px(spacing.s3)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_sm)
                    .text_color(colors.text),
            );
        } else {
            field = field.child(
                div()
                    .id("browser-address-fallback")
                    .min_w_0()
                    .flex_1()
                    .px(spacing.s3)
                    .text_color(colors.text)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_sm)
                    .child(draft),
            );
        }
        field.into_any_element()
    } else {
        let mut button = Button::new("browser-address")
            .ghost()
            .compact()
            .rounded(theme.radii.full)
            .h(address_height)
            .flex_1()
            .min_w_0()
            .justify_start()
            .px(spacing.s3)
            .text_size(theme.typography.fs_sm)
            .text_color(colors.text_2)
            .accessibility_label("Open a page")
            .tooltip(
                status
                    .url
                    .clone()
                    .unwrap_or_else(|| "Open a page".to_owned()),
            )
            .label(address_label);
        if let Some(callback) = address_callback {
            button = button.on_click(move |_, window, cx| {
                callback(BrowserPaneAction::BeginAddressEdit, window, cx);
            });
        }
        button.into_any_element()
    };
    bar = bar.child(address);
    bar = bar.child(pane_button(
        "browser-clips",
        "▣",
        "Clipboard history",
        BrowserPaneAction::ToggleClipboard,
        false,
        pane.state.clips.is_some(),
        callback.clone(),
        theme,
        icon_size,
    ));
    bar = bar.child(pane_button(
        "browser-new-page",
        "+",
        "Open in a new tab",
        BrowserPaneAction::NewTab,
        false,
        false,
        callback.clone(),
        theme,
        icon_size,
    ));
    bar = bar.child(pane_button(
        "browser-external",
        "↗",
        "Open this page in your default browser",
        BrowserPaneAction::OpenExternal,
        status.url.is_none(),
        false,
        callback.clone(),
        theme,
        icon_size,
    ));

    let mut root = v_flex()
        .id("browser-pane")
        .relative()
        .size_full()
        .min_w_0()
        .min_h_0()
        .bg(colors.chrome)
        .text_color(colors.text)
        .font_family(theme.typography.font.clone())
        .text_size(theme.typography.fs_md)
        .line_height(relative(theme.typography.line_height))
        .border_l_1()
        .border_color(colors.border_strong)
        .child(tabs)
        .child(bar);
    if let Some(clips) = pane.state.clips {
        let mut list = v_flex()
            .id("browser-clips-list")
            .max_h(px(260.))
            .mx(spacing.s2)
            .mb(spacing.s2)
            .overflow_y_scroll()
            .border_1()
            .border_color(colors.border)
            .bg(colors.surface_2);
        if clips.is_empty() {
            list = list.child(
                div()
                    .id("browser-clips-empty")
                    .h(px(26.))
                    .px(spacing.s2)
                    .text_color(colors.text_3)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_xs)
                    .child("Nothing copied here yet"),
            );
        } else {
            for (index, clip) in clips.into_iter().enumerate() {
                let label = compact_clip(&clip);
                list = list.child(
                    pane_button(
                        format!("browser-clip-{index}"),
                        "",
                        label,
                        BrowserPaneAction::UseClipboard(index),
                        false,
                        false,
                        callback.clone(),
                        theme,
                        px(0.),
                    )
                    .justify_start()
                    .w_full()
                    .h(px(26.))
                    .px(spacing.s2)
                    .text_color(colors.text_2)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_xs),
                );
            }
        }
        root = root.child(list);
    }
    let mut stage = v_flex()
        .id("browser-stage")
        .relative()
        .flex_1()
        .min_h_0()
        .items_center()
        .justify_center()
        .bg(colors.bg);
    let frame_present = pane.frame.is_some();
    if let Some(frame) = pane.frame.take()
        && pane.state.status.running
        && !pane.state.frame.is_error()
    {
        stage = stage.child(frame);
    }
    if !pane.state.status.running {
        stage = stage.child(empty_state(
            "Nothing open",
            "New tab",
            BrowserPaneAction::NewTab,
            callback,
            theme,
        ));
    } else if pane.state.frame.is_error() {
        let message = match &pane.state.frame {
            PaneFrameState::Error(message) => message.clone(),
            _ => "The page could not be displayed.".to_owned(),
        };
        stage = stage.child(error_state(
            message,
            BrowserPaneAction::Retry,
            callback,
            theme,
        ));
    } else if !frame_present {
        let message = match pane.state.frame {
            PaneFrameState::Loading => "Loading…",
            _ => "Browser frame unavailable",
        };
        stage = stage.child(
            div()
                .id("browser-frame-state")
                .text_color(colors.text_3)
                .child(message),
        );
    }
    root.child(stage).into_any_element()
}

fn render_component(mut pane: BrowserPaneView, theme: &EmmaTheme, _: &mut App) -> AnyElement {
    let colors = theme.colors;
    let spacing = theme.spacing;
    let component = pane
        .state
        .component
        .clone()
        .unwrap_or_else(|| ComponentChromeState::new("", "Component"));
    let callback = pane.callback.clone();
    let mut header = h_flex()
        .id("component-header")
        .items_center()
        .gap(spacing.s1)
        .min_h(px(26.))
        .pl(spacing.s4)
        .pr(spacing.s2)
        .bg(colors.surface_2);
    header = header.child(
        div()
            .id("component-title")
            .min_w_0()
            .flex_1()
            .overflow_hidden()
            .text_color(colors.text_2)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_xs)
            .child(component.title.clone()),
    );
    if component.expands {
        header = header.child(pane_button(
            "component-expand",
            if component.open() { "−" } else { "□" },
            if component.open() {
                "Close full screen"
            } else {
                "Open full screen"
            },
            BrowserPaneAction::ComponentExpand(!component.open()),
            false,
            component.open(),
            callback.clone(),
            theme,
            px(22.),
        ));
    }
    header = header.child(pane_button(
        "component-menu",
        "⋯",
        format!("More for {}", component.title),
        BrowserPaneAction::ComponentMenu(!component.menu_open),
        false,
        component.menu_open,
        callback.clone(),
        theme,
        px(22.),
    ));
    let body = render_component_body(&mut pane, &component, theme);
    let mut root = v_flex()
        .id("component-pane")
        .relative()
        .size_full()
        .min_w_0()
        .min_h_0()
        .bg(colors.chrome)
        .text_color(colors.text)
        .child(header)
        .child(body);
    if component.menu_open {
        let menu = v_flex()
            .id("component-menu-list")
            .self_end()
            .min_w(px(160.))
            .p(spacing.s1)
            .gap(px(1.))
            .bg(colors.surface_2)
            .border_1()
            .border_color(colors.border)
            .child(pane_button(
                "component-fullscreen-toggle",
                "",
                if component.expands {
                    "No full screen"
                } else {
                    "Allow full screen"
                },
                BrowserPaneAction::ComponentAllowFullscreen(!component.expands),
                false,
                false,
                callback.clone(),
                theme,
                px(0.),
            ))
            .child(pane_button(
                "component-switch-off",
                "",
                "Switch off",
                BrowserPaneAction::ComponentSwitchOff,
                false,
                false,
                callback.clone(),
                theme,
                px(0.),
            ))
            .child(
                pane_button(
                    "component-delete",
                    "",
                    "Delete…",
                    BrowserPaneAction::ComponentDelete,
                    false,
                    false,
                    callback,
                    theme,
                    px(0.),
                )
                .text_color(colors.danger),
            );
        root = root.child(menu);
    }
    root.into_any_element()
}

fn render_component_body(
    pane: &mut BrowserPaneView,
    component: &ComponentChromeState,
    theme: &EmmaTheme,
) -> AnyElement {
    let colors = theme.colors;
    let mut body = v_flex()
        .id("component-body")
        .relative()
        .flex_1()
        .min_h_0()
        .p(theme.spacing.s3)
        .bg(colors.chrome);
    if let Some(error) = component.error.clone() {
        body = body.child(error_state(
            format!("{} could not run · {error}", component.title),
            BrowserPaneAction::Retry,
            pane.callback.clone(),
            theme,
        ));
    } else if component.loading {
        body = body.child(
            div()
                .id("component-loading")
                .items_center()
                .text_color(colors.text_3)
                .child("Loading…"),
        );
    } else {
        if let Some(frame) = pane.frame.take() {
            body = body.child(frame);
        } else {
            body = body.child(
                div()
                    .id("component-frame-state")
                    .flex_1()
                    .text_color(colors.text_3)
                    .child("Component frame unavailable"),
            );
        }
        if component.revealing {
            body = body.child(
                div()
                    .id("component-reveal")
                    .absolute()
                    .inset_0()
                    .p(theme.spacing.s3)
                    .text_color(colors.accent_2)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_xs)
                    .child(reveal_text()),
            );
        }
    }
    body.into_any_element()
}

fn render_artifact(pane: BrowserPaneView, theme: &EmmaTheme, _: &mut App) -> AnyElement {
    let colors = theme.colors;
    let artifact = pane
        .state
        .artifact
        .clone()
        .unwrap_or_else(|| ArtifactChromeState::new("", "Artifact"));
    let mut root = v_flex()
        .id("artifact-pane")
        .size_full()
        .min_w_0()
        .min_h_0()
        .bg(colors.bg)
        .text_color(colors.text);
    let header = h_flex()
        .id("artifact-header")
        .items_center()
        .min_h(px(32.))
        .px(theme.spacing.s3)
        .border_b_1()
        .border_color(colors.border)
        .child(
            div()
                .id("artifact-title")
                .min_w_0()
                .flex_1()
                .text_color(colors.text_2)
                .text_size(theme.typography.fs_xs)
                .child(artifact.title),
        );
    root = root.child(header);
    if let Some(error) = artifact.error {
        root = root.child(error_state(
            error,
            BrowserPaneAction::Retry,
            pane.callback,
            theme,
        ));
    } else if artifact.loading {
        root = root.child(
            div()
                .id("artifact-loading")
                .flex_1()
                .items_center()
                .justify_center()
                .text_color(colors.text_3)
                .child("Loading…"),
        );
    } else if let Some(frame) = pane.frame {
        root = root.child(
            v_flex()
                .id("artifact-stage")
                .flex_1()
                .min_h_0()
                .child(frame),
        );
    } else {
        root = root.child(
            div()
                .id("artifact-frame-state")
                .flex_1()
                .items_center()
                .justify_center()
                .text_color(colors.text_3)
                .child("Artifact frame unavailable"),
        );
    }
    root.into_any_element()
}

fn render_visual(mut pane: BrowserPaneView, theme: &EmmaTheme, _: &mut App) -> AnyElement {
    let colors = theme.colors;
    let visual = pane
        .state
        .visual
        .clone()
        .unwrap_or_else(|| VisualChromeState::new("", "Picture"));
    let callback = pane.callback.clone();
    let mut header = h_flex()
        .id("visual-header")
        .items_center()
        .gap(theme.spacing.s2)
        .min_h(px(32.))
        .px(theme.spacing.s3)
        .border_b_1()
        .border_color(colors.border);
    header = header.child(
        div()
            .id("visual-title")
            .min_w_0()
            .flex_1()
            .overflow_hidden()
            .text_color(colors.text_2)
            .text_size(theme.typography.fs_xs)
            .child(visual.title.clone()),
    );
    header = header.child(pane_button(
        "visual-pick",
        "",
        if visual.picking { "Done" } else { "Edit" },
        BrowserPaneAction::VisualPick(!visual.picking),
        visual.loading || visual.exporting || visual.keeping,
        visual.picking,
        callback.clone(),
        theme,
        px(0.),
    ));
    header = header.child(pane_button(
        "visual-export",
        "",
        if visual.exporting {
            "Exporting…"
        } else {
            "Export"
        },
        BrowserPaneAction::VisualExport,
        visual.loading || visual.exporting || visual.keeping,
        false,
        callback.clone(),
        theme,
        px(0.),
    ));
    header = header.child(pane_button(
        "visual-keep",
        "",
        if visual.keeping { "Keeping…" } else { "Keep" },
        BrowserPaneAction::VisualKeep,
        visual.loading || visual.exporting || visual.keeping,
        false,
        callback.clone(),
        theme,
        px(0.),
    ));
    let mut root = v_flex()
        .id("visual-pane")
        .size_full()
        .min_w_0()
        .min_h_0()
        .bg(colors.surface)
        .text_color(colors.text)
        .child(header);
    if let Some(error) = visual.error {
        root = root.child(error_state(
            error,
            BrowserPaneAction::Retry,
            callback.clone(),
            theme,
        ));
    } else if visual.loading {
        root = root.child(
            div()
                .id("visual-loading")
                .flex_1()
                .items_center()
                .justify_center()
                .text_color(colors.text_3)
                .child("Loading…"),
        );
    } else {
        let mut stage = v_flex().id("visual-stage").flex_1().min_h_0().child(
            div()
                .id("visual-frame")
                .h(px(visual.height as f32))
                .w_full()
                .bg(colors.bg)
                .child(pane.frame.take().unwrap_or_else(|| {
                    div()
                        .id("visual-frame-unavailable")
                        .size_full()
                        .items_center()
                        .justify_center()
                        .text_color(colors.text_3)
                        .child("Visual frame unavailable")
                        .into_any_element()
                })),
        );
        if let Some(note) = visual.note {
            stage = stage.child(
                div()
                    .id("visual-note")
                    .px(theme.spacing.s3)
                    .py(theme.spacing.s2)
                    .border_t_1()
                    .border_color(colors.border)
                    .text_color(colors.text_3)
                    .text_size(theme.typography.fs_xs)
                    .child(note),
            );
        }
        root = root.child(stage);
    }
    root.into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn pane_button(
    id: impl Into<gpui::ElementId>,
    glyph: impl Into<SharedString>,
    label: impl Into<SharedString>,
    action: BrowserPaneAction,
    disabled: bool,
    selected: bool,
    callback: Option<BrowserPaneCallback>,
    theme: &EmmaTheme,
    size: gpui::Pixels,
) -> Button {
    let label = label.into();
    let glyph = glyph.into();
    let mut button = Button::new(id)
        .ghost()
        .compact()
        .rounded(px(0.))
        .disabled(disabled)
        .selected(selected)
        .toggled(selected)
        .accessibility_label(label.clone())
        .tooltip(label.clone())
        .text_color(theme.colors.text_2)
        .text_size(theme.typography.fs_xs);
    if size > px(0.) {
        button = button.w(size).h(size);
    } else {
        button = button.min_h(px(26.));
    }
    button = button.label(if glyph.is_empty() { label } else { glyph });
    if let Some(callback) = callback {
        button = button.on_click(move |_, window, cx| {
            callback(action.clone(), window, cx);
        });
    }
    button
}

fn empty_state(
    title: &'static str,
    button_label: &'static str,
    action: BrowserPaneAction,
    callback: Option<BrowserPaneCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut root = v_flex()
        .id("browser-empty")
        .items_center()
        .gap(theme.spacing.s3)
        .child(
            div()
                .id("browser-empty-title")
                .text_color(theme.colors.text_3)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_xs)
                .child(title),
        );
    root = root.child(
        pane_button(
            "browser-empty-action",
            "",
            button_label,
            action,
            false,
            false,
            callback,
            theme,
            px(0.),
        )
        .border_1()
        .border_color(theme.colors.border)
        .px(theme.spacing.s3),
    );
    root.into_any_element()
}

fn error_state(
    message: String,
    action: BrowserPaneAction,
    callback: Option<BrowserPaneCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut root = v_flex()
        .id("browser-error")
        .items_center()
        .gap(theme.spacing.s3)
        .max_w(px(360.))
        .child(
            div()
                .id("browser-error-message")
                .text_color(theme.colors.danger)
                .text_size(theme.typography.fs_xs)
                .child(message),
        );
    root = root.child(
        pane_button(
            "browser-error-retry",
            "",
            "Retry",
            action,
            false,
            false,
            callback,
            theme,
            px(0.),
        )
        .border_1()
        .border_color(theme.colors.border),
    );
    root.into_any_element()
}

fn blank_status() -> BrowserStatus {
    BrowserStatus {
        running: false,
        url: None,
        title: None,
        loading: false,
        can_go_back: false,
        can_go_forward: false,
        active_tab: None,
        tabs: Vec::new(),
    }
}

pub fn address_candidate(value: &str) -> String {
    let value = value.trim();
    if value
        .chars()
        .next()
        .is_some_and(|first| first.is_ascii_alphabetic())
        && value
            .chars()
            .take_while(|character| *character != ':')
            .all(|character| {
                character.is_ascii_alphanumeric() || matches!(character, '+' | '.' | '-')
            })
        && value.contains(':')
    {
        value.to_owned()
    } else {
        format!("https://{value}")
    }
}

pub fn validated_address(value: &str) -> Result<String, SecurityError> {
    normalize_navigation_url(&address_candidate(value))
}

pub fn host_name(value: &str) -> String {
    let remainder = value
        .split_once("://")
        .map_or(value, |(_, remainder)| remainder);
    let authority = remainder.split(['/', '?', '#']).next().unwrap_or(remainder);
    let authority = authority.rsplit('@').next().unwrap_or(authority);
    let host = if let Some(value) = authority.strip_prefix('[') {
        value.split_once(']').map_or(value, |(host, _)| host)
    } else {
        authority.split(':').next().unwrap_or(authority)
    };
    let host = host.strip_prefix("www.").unwrap_or(host);
    if host.is_empty() {
        value.to_owned()
    } else {
        host.to_owned()
    }
}

pub fn tab_name(tab: &BrowserTab) -> String {
    let title = tab.title.trim();
    if !title.is_empty() {
        title.to_owned()
    } else {
        let host = host_name(&tab.url);
        if host.is_empty() {
            "New tab".to_owned()
        } else {
            host
        }
    }
}

fn compact_clip(value: &str) -> String {
    bounded_text(
        &value.split_whitespace().collect::<Vec<_>>().join(" "),
        MAX_CLIP_BYTES,
    )
}

fn bounded_clips(clips: Vec<String>) -> Vec<String> {
    clips
        .into_iter()
        .take(MAX_CLIPS)
        .map(|clip| bounded_text(&clip, MAX_CLIP_BYTES))
        .collect()
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    value
        .chars()
        .scan(0usize, |size, character| {
            let next = character.len_utf8();
            if size.saturating_add(next) > max_bytes {
                None
            } else {
                *size += next;
                Some(character)
            }
        })
        .collect()
}

fn reveal_text() -> String {
    let glyphs = "░▒▓█▚▞╱╲┃┇┊+*=~-_/\\<>[]{}();:.,0123456789ABCDEFGHJKLMNPQRSTUVWXYZ";
    glyphs
        .chars()
        .cycle()
        .take(COMPONENT_REVEAL_CHARS)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn browser_status(tabs: Vec<BrowserTab>, active_tab: Option<&str>) -> BrowserStatus {
        let active = active_tab.and_then(|id| tabs.iter().find(|tab| tab.id == id));
        BrowserStatus {
            running: !tabs.is_empty(),
            url: active.map(|tab| tab.url.clone()),
            title: active.map(|tab| tab.title.clone()),
            loading: active.is_some_and(|tab| tab.loading),
            can_go_back: active.is_some_and(|tab| tab.can_go_back),
            can_go_forward: active.is_some_and(|tab| tab.can_go_forward),
            active_tab: active_tab.map(str::to_owned),
            tabs,
        }
    }

    fn tab(id: &str, url: &str) -> BrowserTab {
        BrowserTab {
            id: id.to_owned(),
            surface: SurfaceKind::Browser,
            url: url.to_owned(),
            title: String::new(),
            favicon: None,
            loading: false,
            can_go_back: false,
            can_go_forward: false,
        }
    }

    #[test]
    fn address_candidate_preserves_schemes_and_adds_https() {
        assert_eq!(address_candidate("example.com"), "https://example.com");
        assert_eq!(
            address_candidate("https://example.com/a"),
            "https://example.com/a"
        );
        assert_eq!(address_candidate("about:blank"), "about:blank");
        assert_eq!(
            validated_address("example.com").unwrap(),
            "https://example.com"
        );
    }

    #[test]
    fn address_actions_commit_and_cancel() {
        let mut state = BrowserPaneState::from_status(
            BrowserPaneKind::Browser,
            browser_status(vec![tab("t1", "https://old.example")], Some("t1")),
        );
        assert_eq!(state.reduce(BrowserPaneAction::BeginAddressEdit), None);
        assert_eq!(
            state.reduce(BrowserPaneAction::SetAddress("new.example".to_owned())),
            None
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::SubmitAddress),
            Some(BrowserPaneEffect::AddressSubmitted(
                "https://new.example".to_owned()
            ))
        );
        assert_eq!(state.address, AddressState::Viewing);
        assert_eq!(state.reduce(BrowserPaneAction::BeginAddressEdit), None);
        assert_eq!(state.reduce(BrowserPaneAction::CancelAddress), None);
        assert_eq!(state.address, AddressState::Viewing);
    }

    #[test]
    fn tab_actions_preserve_neighbor_selection() {
        let mut state = BrowserPaneState::from_status(
            BrowserPaneKind::Browser,
            browser_status(
                vec![
                    tab("t1", "https://one.example"),
                    tab("t2", "https://two.example"),
                ],
                Some("t1"),
            ),
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::SelectTab("t2".to_owned())),
            Some(BrowserPaneEffect::SelectTab("t2".to_owned()))
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::CloseTab("t2".to_owned())),
            Some(BrowserPaneEffect::CloseTab("t2".to_owned()))
        );
        assert_eq!(state.status.active_tab.as_deref(), Some("t1"));
        assert_eq!(
            state.reduce(BrowserPaneAction::CloseTab("t1".to_owned())),
            Some(BrowserPaneEffect::CloseTab("t1".to_owned()))
        );
        assert!(!state.status.running);
        assert_eq!(state.frame, PaneFrameState::Empty);
    }

    #[test]
    fn navigation_obeys_browser_history_state() {
        let mut current = tab("t1", "https://one.example");
        current.can_go_back = true;
        current.can_go_forward = false;
        let mut state = BrowserPaneState::from_status(
            BrowserPaneKind::Browser,
            browser_status(vec![current], Some("t1")),
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::Back),
            Some(BrowserPaneEffect::Navigate(Navigation::Back))
        );
        assert_eq!(state.reduce(BrowserPaneAction::Forward), None);
        assert_eq!(
            state.reduce(BrowserPaneAction::Reload),
            Some(BrowserPaneEffect::Navigate(Navigation::Reload))
        );
    }

    #[test]
    fn clipboard_actions_are_correlated_and_bounded() {
        let mut state = BrowserPaneState::new(BrowserPaneKind::Browser);
        assert_eq!(
            state.reduce(BrowserPaneAction::ToggleClipboard),
            Some(BrowserPaneEffect::ClipboardRequested)
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::UseClipboard(0)),
            Some(BrowserPaneEffect::Blocked(SecurityError::MessageInvalid))
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::SetClips(vec!["first".to_owned()])),
            None
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::UseClipboard(0)),
            Some(BrowserPaneEffect::ClipboardUse(0))
        );
    }

    #[test]
    fn component_actions_keep_fullscreen_and_screenshot_intents_typed() {
        let mut component = ComponentChromeState::new("c1", "Widget");
        component.expands = true;
        let mut state = BrowserPaneState::new(BrowserPaneKind::Component).with_component(component);
        assert_eq!(state.reduce(BrowserPaneAction::ComponentLoaded), None);
        assert!(state.component.as_ref().is_some_and(|one| one.revealing));
        assert_eq!(
            state.reduce(BrowserPaneAction::ComponentExpand(true)),
            Some(BrowserPaneEffect::Component(
                ComponentPaneEffect::SetExpanded(true)
            ))
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::ComponentScreenshot),
            Some(BrowserPaneEffect::Component(
                ComponentPaneEffect::Screenshot {
                    id: "c1".to_owned()
                }
            ))
        );
        assert_eq!(state.reduce(BrowserPaneAction::ComponentScreenshot), None);
    }

    #[test]
    fn visual_measure_and_pick_are_clamped() {
        let mut state = BrowserPaneState::new(BrowserPaneKind::Visual)
            .with_visual(VisualChromeState::new("v1", "Picture"));
        assert_eq!(state.reduce(BrowserPaneAction::VisualMeasure(1)), None);
        assert_eq!(
            state.visual.as_ref().map(|visual| visual.height),
            Some(VISUAL_MIN_HEIGHT)
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::VisualMeasure(u32::MAX)),
            None
        );
        assert_eq!(
            state.visual.as_ref().map(|visual| visual.height),
            Some(VISUAL_MAX_HEIGHT)
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::VisualPicked {
                label: "body > main".to_owned(),
                html: "<main>ok</main>".to_owned(),
            }),
            Some(BrowserPaneEffect::Visual(VisualPaneEffect::Picked {
                label: "body > main".to_owned(),
                html: "<main>ok</main>".to_owned(),
            }))
        );
    }

    #[test]
    fn popup_download_and_external_intents_use_security_decisions() {
        let mut state = BrowserPaneState::from_status(
            BrowserPaneKind::Browser,
            browser_status(vec![tab("t1", "https://example.com")], Some("t1")),
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::OpenExternal),
            Some(BrowserPaneEffect::OpenExternal(
                "https://example.com".to_owned()
            ))
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::Popup("https://popup.example".to_owned())),
            Some(BrowserPaneEffect::PopupNewTab(
                "https://popup.example".to_owned()
            ))
        );
        assert_eq!(
            state.reduce(BrowserPaneAction::Download(
                "https://download.example".to_owned()
            )),
            Some(BrowserPaneEffect::Download(
                "https://download.example".to_owned()
            ))
        );
        assert!(matches!(
            state.reduce(BrowserPaneAction::Popup("javascript:alert(1)".to_owned())),
            Some(BrowserPaneEffect::Blocked(_))
        ));
    }

    #[test]
    fn labels_and_geometry_match_browser_contract() {
        let mut current = tab("t1", "https://www.example.com/path");
        assert_eq!(tab_name(&current), "example.com");
        current.title = "A page".to_owned();
        assert_eq!(tab_name(&current), "A page");
        assert_eq!(host_name("https://user@example.com:443/a"), "example.com");
        assert_eq!(BROWSER_TABS_HEIGHT, 38.);
        assert_eq!(BROWSER_BAR_HEIGHT, 36.);
        assert_eq!(BROWSER_ADDRESS_HEIGHT, 30.);
        assert_eq!(PIP_ADDRESS_HEIGHT, 26.);
        assert_eq!(VISUAL_DEFAULT_WIDTH, 720);
    }
}
