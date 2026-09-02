use std::rc::Rc;

use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, Hsla, InteractiveElement as _, IntoElement,
    ParentElement as _, RenderOnce, SharedString, StatefulInteractiveElement as _, Styled as _,
    Window, accesskit::Role, div, prelude::FluentBuilder as _, px, relative,
};
use gpui_component::{
    Disableable as _, FocusTrapElement as _, Selectable as _, StyledExt as _,
    button::{Button, ButtonCustomVariant, ButtonVariants as _},
    checkbox::Checkbox,
    h_flex,
    input::{Input, InputContentType, InputState, Textarea, TextareaState},
    switch::Switch,
    v_flex,
};

use crate::{
    navigation::{self, SettingsCategory},
    theme::EmmaTheme,
};

pub type SettingsCallback = Rc<dyn Fn(SettingsAction, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsPageId {
    Keybinds,
    Notch,
    Voice,
    Appearance,
    ContextBar,
    Models,
    Prompts,
    Tools,
    Permissions,
    Harness,
    Imports,
    Mobile,
    Built,
    Privacy,
    About,
}

impl SettingsPageId {
    pub const ALL: [Self; 15] = [
        Self::Keybinds,
        Self::Notch,
        Self::Voice,
        Self::Appearance,
        Self::ContextBar,
        Self::Models,
        Self::Prompts,
        Self::Tools,
        Self::Permissions,
        Self::Harness,
        Self::Imports,
        Self::Mobile,
        Self::Built,
        Self::Privacy,
        Self::About,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Keybinds => "keybinds",
            Self::Notch => "notch",
            Self::Voice => "voice",
            Self::Appearance => "appearance",
            Self::ContextBar => "contextbar",
            Self::Models => "models",
            Self::Prompts => "prompts",
            Self::Tools => "tools",
            Self::Permissions => "permissions",
            Self::Harness => "harness",
            Self::Imports => "imports",
            Self::Mobile => "mobile",
            Self::Built => "built",
            Self::Privacy => "privacy",
            Self::About => "about",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        Self::ALL.into_iter().find(|page| page.id() == id)
    }

    pub fn navigation(self) -> &'static navigation::SettingsPage {
        navigation::settings_page(self.id()).expect("settings page ids are exhaustive")
    }

    pub fn category(self) -> SettingsCategory {
        self.navigation().category
    }

    pub fn label(self, platform: Platform) -> &'static str {
        self.navigation().label_for_platform(platform.id())
    }

    pub fn copy(self, platform: Platform) -> &'static str {
        self.navigation().copy_for_platform(platform.id())
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Platform {
    #[default]
    MacOS,
    Windows,
    Other,
}

impl Platform {
    pub const fn id(self) -> &'static str {
        match self {
            Self::MacOS => "darwin",
            Self::Windows => "win32",
            Self::Other => "other",
        }
    }

    pub const fn name(self) -> &'static str {
        match self {
            Self::MacOS => "macOS",
            Self::Windows => "Windows",
            Self::Other => "this computer",
        }
    }

    pub const fn device(self) -> &'static str {
        match self {
            Self::MacOS => "Mac",
            Self::Windows => "PC",
            Self::Other => "computer",
        }
    }

    pub const fn option(self) -> &'static str {
        match self {
            Self::MacOS => "Option",
            Self::Windows => "Alt",
            Self::Other => "Alt",
        }
    }

    pub const fn command(self) -> &'static str {
        match self {
            Self::MacOS => "⌘",
            Self::Windows => "Ctrl",
            Self::Other => "Ctrl",
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum InputId {
    QuickActionLabel(u8),
    QuickActionPrompt(u8),
    VoiceEndpoint,
    VoiceModel,
    CleanupEndpoint,
    CleanupModel,
    NotchGap,
    ModelsSearch,
    ProviderName,
    ProviderBaseUrl,
    ProviderModelId,
    ProviderCredentialEnv,
    ProviderContextWindow,
    SystemPrompt,
    PromptName(u16),
    PromptBody(u16),
    VerifierRules,
    AdvisorRules,
    VisionRules,
    SecretRules,
    Credential(u16),
    CustomCredentialEnv,
    SearchEndpoint(u16),
    SearchCredential(u16),
    BuiltVariable(u16, u16),
    MobilePin,
    VaultFolder,
}

#[derive(Clone, Default)]
pub struct SettingsInputs {
    single_line: Vec<(InputId, Entity<InputState>)>,
    multiline: Vec<(InputId, Entity<TextareaState>)>,
}

impl SettingsInputs {
    pub fn single(mut self, id: InputId, state: Entity<InputState>) -> Self {
        self.single_line.push((id, state));
        self
    }

    pub fn multiline(mut self, id: InputId, state: Entity<TextareaState>) -> Self {
        self.multiline.push((id, state));
        self
    }

    fn single_line(&self, id: InputId) -> Option<Entity<InputState>> {
        self.single_line
            .iter()
            .find(|(candidate, _)| *candidate == id)
            .map(|(_, state)| state.clone())
    }

    fn textarea_state(&self, id: InputId) -> Option<Entity<TextareaState>> {
        self.multiline
            .iter()
            .find(|(candidate, _)| *candidate == id)
            .map(|(_, state)| state.clone())
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum SettingsAsyncState {
    #[default]
    Idle,
    Loading,
    Ready,
    Error(SharedString),
    Disabled(SharedString),
    Rollback(SharedString),
}

impl SettingsAsyncState {
    pub fn label(&self) -> Option<(&'static str, SharedString)> {
        match self {
            Self::Idle => None,
            Self::Loading => Some(("loading", "Loading…".into())),
            Self::Ready => Some(("ready", "Ready".into())),
            Self::Error(message) => Some(("error", message.clone())),
            Self::Disabled(message) => Some(("disabled", message.clone())),
            Self::Rollback(message) => Some(("rollback", message.clone())),
        }
    }

    pub fn blocks_input(&self) -> bool {
        matches!(self, Self::Loading | Self::Disabled(_) | Self::Rollback(_))
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub enum ValidationState {
    #[default]
    Valid,
    Invalid(SharedString),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AccentChoice {
    Orange,
    Rose,
    Lime,
    Teal,
    Blue,
    Violet,
    Custom(SharedString),
}

impl AccentChoice {
    const ALL: [Self; 6] = [
        Self::Orange,
        Self::Rose,
        Self::Lime,
        Self::Teal,
        Self::Blue,
        Self::Violet,
    ];

    const fn id(&self) -> &'static str {
        match self {
            Self::Orange => "orange",
            Self::Rose => "rose",
            Self::Lime => "lime",
            Self::Teal => "teal",
            Self::Blue => "blue",
            Self::Violet => "violet",
            Self::Custom(_) => "custom",
        }
    }

    const fn label(&self) -> &'static str {
        match self {
            Self::Orange => "Orange",
            Self::Rose => "Rose",
            Self::Lime => "Lime",
            Self::Teal => "Teal",
            Self::Blue => "Blue",
            Self::Violet => "Violet",
            Self::Custom(_) => "Any colour",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ConversationWidth {
    #[default]
    Default,
    High,
    Max,
}

impl ConversationWidth {
    const ALL: [Self; 3] = [Self::Default, Self::High, Self::Max];

    const fn label(self) -> &'static str {
        match self {
            Self::Default => "Default · 720px",
            Self::High => "High · 1080px",
            Self::Max => "Max · full pane",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum FontChoice {
    Departure,
    #[default]
    Inter,
    System,
    Mono,
    Rounded,
    Serif,
}

impl FontChoice {
    const ALL: [Self; 6] = [
        Self::Departure,
        Self::Inter,
        Self::System,
        Self::Mono,
        Self::Rounded,
        Self::Serif,
    ];

    const fn label(self) -> &'static str {
        match self {
            Self::Departure => "Departure Mono",
            Self::Inter => "Inter",
            Self::System => "System sans",
            Self::Mono => "System mono",
            Self::Rounded => "System rounded",
            Self::Serif => "System serif",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TranscriptionEngine {
    #[default]
    Apple,
    Server,
}

impl TranscriptionEngine {
    const ALL: [Self; 2] = [Self::Apple, Self::Server];

    const fn label(self, platform: Platform) -> &'static str {
        match self {
            Self::Apple => match platform {
                Platform::Windows => "Windows · built in",
                _ => "macOS · built in",
            },
            Self::Server => "llama.cpp server",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum NotchConcurrency {
    #[default]
    Separate,
    Continue,
}

impl NotchConcurrency {
    const ALL: [Self; 2] = [Self::Separate, Self::Continue];

    const fn label(self) -> &'static str {
        match self {
            Self::Separate => "A separate task",
            Self::Continue => "The running task",
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PermissionMode {
    Plan,
    #[default]
    Ask,
    Auto,
    Full,
}

impl PermissionMode {
    const ALL: [Self; 4] = [Self::Plan, Self::Ask, Self::Auto, Self::Full];

    const fn label(self) -> &'static str {
        match self {
            Self::Plan => "Plan",
            Self::Ask => "Ask",
            Self::Auto => "Auto",
            Self::Full => "Full access",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct QuickActionState {
    pub label: SharedString,
    pub prompt: SharedString,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShortcutState {
    pub id: SharedString,
    pub label: SharedString,
    pub detail: SharedString,
    pub builtin: Option<SharedString>,
    pub key: Option<SharedString>,
    pub hold_ms: Option<u32>,
    pub recording: bool,
    pub refused: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CursorOrbState {
    pub enabled: bool,
    pub commands_enabled: bool,
    pub commands: Vec<SharedString>,
    pub selected: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct KeybindsPageState {
    pub shortcuts: Vec<ShortcutState>,
    pub bound: usize,
    pub quick_actions: Vec<QuickActionState>,
    pub orbs: CursorOrbState,
    pub saved: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct NotchPageState {
    pub model: SharedString,
    pub concurrency: NotchConcurrency,
    pub notch_gap: u16,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VoicePageState {
    pub microphone: PermissionStatus,
    pub speech_ready: bool,
    pub speech_error: Option<SharedString>,
    pub cleanup_running: bool,
    pub cleanup_model_loaded: bool,
    pub transcription_enabled: bool,
    pub engine: TranscriptionEngine,
    pub hold_ms: u16,
    pub cleanup_enabled: bool,
    pub serving_models: Vec<SharedString>,
    pub heard: Option<SharedString>,
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum PermissionStatus {
    Granted,
    Denied,
    Restricted,
    NotDetermined,
    #[default]
    Unknown,
}

impl PermissionStatus {
    const fn label(self, platform: Platform) -> &'static str {
        match self {
            Self::Granted => "Granted",
            Self::Denied => match platform {
                Platform::Windows => "Refused — Windows is blocking it",
                _ => "Refused — macOS is blocking it",
            },
            Self::Restricted => "Blocked by this computer's policy",
            Self::NotDetermined => "Not asked yet",
            Self::Unknown => "Checking…",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AppearancePageState {
    pub accent: AccentChoice,
    pub ui_scale: u16,
    pub conversation_width: ConversationWidth,
    pub nav_icon_colors: bool,
    pub nav_hues: Vec<(SharedString, AccentChoice)>,
    pub interface_font: FontChoice,
    pub agent_font: FontChoice,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextBarPage {
    pub id: SharedString,
    pub name: SharedString,
    pub widgets: Vec<SharedString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContextBarPageState {
    pub pages: Vec<ContextBarPage>,
    pub active: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelOption {
    pub id: SharedString,
    pub name: SharedString,
    pub detail: SharedString,
    pub maker: SharedString,
    pub free: bool,
    pub active: bool,
    pub starred: bool,
    pub accepts_images: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProviderState {
    pub id: SharedString,
    pub name: SharedString,
    pub model_id: SharedString,
    pub base_url: SharedString,
    pub credential_env: SharedString,
    pub context_window: u64,
    pub reach: SharedString,
    pub active: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifierPageState {
    pub model: SharedString,
    pub endpoint: SharedString,
    pub credential_env: SharedString,
    pub configured: bool,
    pub system_chars: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialState {
    pub env: SharedString,
    pub label: SharedString,
    pub detail: SharedString,
    pub masked: Option<SharedString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ModelsPageState {
    pub catalog: Vec<ModelOption>,
    pub selected_model: SharedString,
    pub providers: Vec<ProviderState>,
    pub verifier: VerifierPageState,
    pub advisor: VerifierPageState,
    pub vision: VerifierPageState,
    pub secret: VerifierPageState,
    pub credentials: Vec<CredentialState>,
    pub require_zero_retention: bool,
    pub transcription_enabled: bool,
    pub catalog_status: SettingsAsyncState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptPresetState {
    pub id: SharedString,
    pub name: SharedString,
    pub scope: SharedString,
    pub enabled: bool,
    pub body_chars: usize,
    pub applies: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptsPageState {
    pub global_chars: usize,
    pub presets: Vec<PromptPresetState>,
    pub maximum: usize,
    pub system_status: SettingsAsyncState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolState {
    pub id: SharedString,
    pub label: SharedString,
    pub blurb: SharedString,
    pub group: SharedString,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SearchProviderState {
    pub id: SharedString,
    pub label: SharedString,
    pub detail: SharedString,
    pub endpoint: SharedString,
    pub credential_env: SharedString,
    pub free: bool,
    pub keyless: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolTargetState {
    pub id: SharedString,
    pub name: SharedString,
    pub source: SharedString,
    pub enabled: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolsPageState {
    pub default_mode: PermissionMode,
    pub tools: Vec<ToolState>,
    pub search: Vec<SearchProviderState>,
    pub written: Vec<ToolTargetState>,
    pub skills: Vec<ToolTargetState>,
    pub servers: Vec<ToolTargetState>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetupPermissionId {
    Accessibility,
    Screen,
    Microphone,
    Speech,
    Automation,
    Notifications,
    Files,
}

impl SetupPermissionId {
    pub const ALL: [Self; 7] = [
        Self::Accessibility,
        Self::Screen,
        Self::Microphone,
        Self::Speech,
        Self::Automation,
        Self::Notifications,
        Self::Files,
    ];

    const fn id(self) -> &'static str {
        match self {
            Self::Accessibility => "accessibility",
            Self::Screen => "screen",
            Self::Microphone => "microphone",
            Self::Speech => "speech",
            Self::Automation => "automation",
            Self::Notifications => "notifications",
            Self::Files => "files",
        }
    }

    const fn title(self) -> &'static str {
        match self {
            Self::Accessibility => "Accessibility",
            Self::Screen => "Screen Recording",
            Self::Microphone => "Microphone",
            Self::Speech => "Speech Recognition",
            Self::Automation => "Automation",
            Self::Notifications => "Notifications",
            Self::Files => "Files & Folders",
        }
    }

    const fn unavailable(self, platform: Platform) -> bool {
        matches!(platform, Platform::Windows)
            && matches!(self, Self::Accessibility | Self::Speech | Self::Automation)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionGrant {
    pub id: SetupPermissionId,
    pub status: Option<bool>,
    pub tasks: Vec<SharedString>,
    pub what: SharedString,
    pub why: SharedString,
    pub relaunch: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PermissionsPageState {
    pub grants: Vec<PermissionGrant>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HarnessPageState {
    pub reinject_steps: u16,
    pub reinject_percent: u8,
    pub prune_steps: u16,
    pub prune_percent: u8,
    pub auto_compact_percent: u8,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportSourceState {
    pub id: SharedString,
    pub label: SharedString,
    pub skills: usize,
    pub mcp_configs: usize,
    pub locations: Vec<SharedString>,
    pub selected: bool,
    pub available: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportsPageState {
    pub sources: Vec<ImportSourceState>,
    pub scan_status: SettingsAsyncState,
    pub import_status: SettingsAsyncState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MobileDeviceState {
    pub id: u64,
    pub connected: bool,
    pub last_seen: SharedString,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct MobilePageState {
    pub pin_ready: bool,
    pub pairing: bool,
    pub pairing_code: Option<SharedString>,
    pub expires_in: Option<u32>,
    pub devices: Vec<MobileDeviceState>,
    pub listening: bool,
    pub address: Option<SharedString>,
    pub full: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuiltCardState {
    pub id: SharedString,
    pub title: SharedString,
    pub version: u32,
    pub expands: bool,
    pub disabled: bool,
    pub variables: Vec<SharedString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct BuiltPageState {
    pub cards: Vec<BuiltCardState>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PrivacyPageState {
    pub reset_confirmation: bool,
    pub openrouter_url: SharedString,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CreditState {
    pub title: SharedString,
    pub body: SharedString,
    pub href: Option<SharedString>,
    pub link: Option<SharedString>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AboutPageState {
    pub credits: Vec<CreditState>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
#[allow(clippy::large_enum_variant)]
pub enum SettingsPageState {
    Keybinds(KeybindsPageState),
    Notch(NotchPageState),
    Voice(VoicePageState),
    Appearance(AppearancePageState),
    ContextBar(ContextBarPageState),
    Models(ModelsPageState),
    Prompts(PromptsPageState),
    Tools(ToolsPageState),
    Permissions(PermissionsPageState),
    Harness(HarnessPageState),
    Imports(ImportsPageState),
    Mobile(MobilePageState),
    Built(BuiltPageState),
    Privacy(PrivacyPageState),
    About(AboutPageState),
}

#[derive(Clone, Debug)]
pub struct SettingsState {
    pub platform: Platform,
    pub status: SettingsAsyncState,
    pub validation: ValidationState,
    pub disabled: bool,
    pub page: SettingsPageState,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum KeybindAction {
    Capture(SharedString),
    Clear(SharedString),
    SetHoldMs(SharedString, u32),
    SetQuickActionLabel(u8, SharedString),
    SetQuickActionPrompt(u8, SharedString),
    ToggleOrbs(bool),
    ToggleCommands(bool),
    SetOrbCount(u8),
    SelectOrb(usize),
    SetOrbCommand(SharedString),
    MoveOrb(i8),
    Save,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum NotchAction {
    SelectModel(SharedString),
    SetConcurrency(NotchConcurrency),
    SetGap(u16),
    Save,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum VoiceAction {
    SetEnabled(bool),
    SetEngine(TranscriptionEngine),
    SetEndpoint(SharedString),
    SetModel(SharedString),
    SetCleanupEndpoint(SharedString),
    SetCleanupModel(SharedString),
    SetCleanup(bool),
    SetHoldMs(u16),
    RequestMicrophone,
    OpenSpeechSettings,
    Refresh,
    StartTry,
    StopTry,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AppearanceAction {
    SetAccent(AccentChoice),
    SetScale(u16),
    SetConversationWidth(ConversationWidth),
    ToggleNavColors(bool),
    SetNavHue(SharedString, AccentChoice),
    ResetNavHues,
    SetInterfaceFont(FontChoice),
    SetAgentFont(FontChoice),
    Save,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContextBarAction {
    SelectPage(usize),
    AddPage,
    DeletePage,
    RenamePage(SharedString),
    AddWidget(SharedString),
    RemoveWidget(SharedString),
    MoveWidget(SharedString, i8),
    SetWidgetOrientation(SharedString, bool),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ModelsAction {
    Search(SharedString),
    SelectModel(SharedString),
    ToggleFavorite(SharedString),
    AddRouter,
    RemoveRouter(SharedString),
    EditRouterName(SharedString, SharedString),
    SetPrivateRouting(bool),
    TestProvider,
    AddProvider,
    RemoveProvider(SharedString),
    SelectProvider(SharedString),
    SaveVerifier,
    SaveAdvisor,
    SaveVision,
    SaveSecret,
    SaveCredential(SharedString),
    RemoveCredential(SharedString),
    AddCredentialSlot,
    ReloadCatalog,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PromptsAction {
    SetGlobal(SharedString),
    InsertVariable(SharedString, SharedString),
    ResetGlobal,
    ForkGlobal,
    TogglePreset(SharedString, bool),
    SetPresetName(SharedString, SharedString),
    SetPresetBody(SharedString, SharedString),
    SetPresetScope(SharedString, SharedString),
    ForkPreset(SharedString),
    DeletePreset(SharedString),
    AddPreset,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolsAction {
    SetDefaultMode(PermissionMode),
    ToggleTool(SharedString, bool),
    ToggleSkill(SharedString, bool),
    ToggleServer(SharedString, bool),
    SearchProviderUp(usize),
    SearchProviderDown(usize),
    RemoveSearchProvider(SharedString),
    AddSearchProvider,
    SaveSearchRanking,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PermissionsAction {
    OpenCapability(SetupPermissionId),
    Refresh,
    OpenTools,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum HarnessAction {
    ToggleReinject(bool),
    SetReinjectSteps(u16),
    SetReinjectPercent(u8),
    TogglePrune(bool),
    SetPruneSteps(u16),
    SetPrunePercent(u8),
    ToggleAutoCompact(bool),
    SetAutoCompactPercent(u8),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ImportsAction {
    Scan,
    ToggleSource(SharedString, bool),
    ImportSelected,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum MobileAction {
    SetPin(SharedString),
    Pair,
    CancelPair,
    Unpair(u64),
    ConfirmUnpair(u64),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum BuiltAction {
    Attach(SharedString),
    ToggleExpanded(SharedString, bool),
    ToggleEnabled(SharedString, bool),
    Delete(SharedString),
    ConfirmDelete(SharedString),
    DeleteAll,
    ConfirmDeleteAll,
    SaveVariable(SharedString),
    ClearVariable(SharedString),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum PrivacyAction {
    BeginReset,
    ConfirmReset,
    CancelReset,
    OpenOpenRouterPrivacy,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum AboutAction {
    OpenLink(SharedString),
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SettingsAction {
    SelectPage(SettingsPageId),
    Keybinds(KeybindAction),
    Notch(NotchAction),
    Voice(VoiceAction),
    Appearance(AppearanceAction),
    ContextBar(ContextBarAction),
    Models(ModelsAction),
    Prompts(PromptsAction),
    Tools(ToolsAction),
    Permissions(PermissionsAction),
    Harness(HarnessAction),
    Imports(ImportsAction),
    Mobile(MobileAction),
    Built(BuiltAction),
    Privacy(PrivacyAction),
    About(AboutAction),
    Retry(SettingsPageId),
    Setup(SetupAction),
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum SetupStep {
    #[default]
    Emma,
    Model,
    QuickAsk,
    Permissions,
    Knowledge,
    Agents,
}

impl SetupStep {
    pub const ALL: [Self; 6] = [
        Self::Emma,
        Self::Model,
        Self::QuickAsk,
        Self::Permissions,
        Self::Knowledge,
        Self::Agents,
    ];

    pub const fn index(self) -> usize {
        match self {
            Self::Emma => 0,
            Self::Model => 1,
            Self::QuickAsk => 2,
            Self::Permissions => 3,
            Self::Knowledge => 4,
            Self::Agents => 5,
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Emma => "Emma",
            Self::Model => "Model",
            Self::QuickAsk => "Quick Ask",
            Self::Permissions => "Permissions",
            Self::Knowledge => "Knowledge",
            Self::Agents => "Agents",
        }
    }

    pub const fn previous(self) -> Option<Self> {
        match self {
            Self::Emma => None,
            Self::Model => Some(Self::Emma),
            Self::QuickAsk => Some(Self::Model),
            Self::Permissions => Some(Self::QuickAsk),
            Self::Knowledge => Some(Self::Permissions),
            Self::Agents => Some(Self::Knowledge),
        }
    }

    pub const fn next(self) -> Option<Self> {
        match self {
            Self::Emma => Some(Self::Model),
            Self::Model => Some(Self::QuickAsk),
            Self::QuickAsk => Some(Self::Permissions),
            Self::Permissions => Some(Self::Knowledge),
            Self::Knowledge => Some(Self::Agents),
            Self::Agents => None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupVaultState {
    pub name: SharedString,
    pub root: SharedString,
    pub folder: SharedString,
    pub kind: SharedString,
    pub files_ready: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SetupState {
    pub open: bool,
    pub step: SetupStep,
    pub status: SettingsAsyncState,
    pub permissions: Vec<PermissionGrant>,
    pub openrouter_saved: bool,
    pub openrouter_masked: Option<SharedString>,
    pub balance: Option<SharedString>,
    pub selected_model: SharedString,
    pub model_options: Vec<ModelOption>,
    pub quick_ask_tapped: bool,
    pub vault: Option<SetupVaultState>,
    pub detected_vaults: Vec<SetupVaultState>,
    pub selected_imports: Vec<SharedString>,
    pub import_sources: Vec<ImportSourceState>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SetupAction {
    Close,
    Back,
    Continue,
    Skip,
    SaveOpenRouterKey,
    RemoveOpenRouterKey,
    SelectModel(SharedString),
    ManageModels,
    ShowQuickAsk,
    OpenCapability(SetupPermissionId),
    ChooseVault(SharedString),
    PickVaultFolder,
    SetVaultFolder(SharedString),
    ToggleImport(SharedString, bool),
    ImportSelected,
    Retry,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SetupMarkState {
    On,
    Off,
    Unknown,
}

pub struct SettingsPages {
    page: SettingsPageId,
    state: SettingsState,
    inputs: SettingsInputs,
    callback: Option<SettingsCallback>,
    setup: Option<SetupState>,
    setup_focus: Option<FocusHandle>,
}

impl SettingsPages {
    pub fn new(page: SettingsPageId, state: SettingsState) -> Self {
        Self {
            page,
            state,
            inputs: SettingsInputs::default(),
            callback: None,
            setup: None,
            setup_focus: None,
        }
    }

    pub fn inputs(mut self, inputs: SettingsInputs) -> Self {
        self.inputs = inputs;
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(SettingsAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }

    pub fn setup(mut self, setup: SetupState) -> Self {
        self.setup = Some(setup);
        self
    }

    pub fn setup_focus(mut self, focus: FocusHandle) -> Self {
        self.setup_focus = Some(focus);
        self
    }
}

impl RenderOnce for SettingsPages {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let state = self.state.clone();
        let page = self.page;
        let callback = self.callback.clone();
        let mut root = h_flex()
            .id("settings-layout")
            .relative()
            .size_full()
            .bg(theme.colors.bg)
            .text_color(theme.colors.text)
            .font_family(theme.typography.font.clone())
            .text_size(theme.typography.fs_md)
            .line_height(relative(theme.typography.line_height))
            .child(render_settings_nav(
                page,
                state.platform,
                state.disabled || state.status.blocks_input(),
                &callback,
                &theme,
                cx,
            ))
            .child(render_settings_body(
                page,
                &state,
                &self.inputs,
                &callback,
                &theme,
                cx,
            ));
        if let Some(setup) = self.setup
            && setup.open
        {
            let focus = self.setup_focus.unwrap_or_else(|| cx.focus_handle());
            root = root.child(render_setup_dialog(
                setup,
                focus,
                state.platform,
                &self.inputs,
                &callback,
                &theme,
                window,
                cx,
            ));
        }
        root
    }
}

fn render_settings_nav(
    page: SettingsPageId,
    platform: Platform,
    disabled: bool,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> impl IntoElement {
    let colors = theme.colors;
    let spacing = theme.spacing;
    let mut nav = v_flex()
        .id("settings-sidebar")
        .w(px(184.))
        .h_full()
        .flex_none()
        .min_h_0()
        .overflow_y_scroll()
        .p(spacing.s4)
        .pt(spacing.s5)
        .border_r_1()
        .border_color(colors.border_strong)
        .font_family(theme.typography.font_mono.clone());
    nav = nav.child(
        div()
            .id("settings-sidebar-title")
            .px(spacing.s2)
            .pb(spacing.s3)
            .text_color(colors.text_3)
            .text_size(theme.typography.fs_2xs)
            .child("SETTINGS"),
    );
    for category in SettingsCategory::ALL {
        let mut group = v_flex()
            .id(format!("settings-group-{}", category.label()))
            .mt(spacing.s3)
            .pt(spacing.s3)
            .border_t_1()
            .border_color(colors.border);
        group = group.child(
            div()
                .px(spacing.s2)
                .pb(spacing.s2)
                .text_color(category_color(category, colors))
                .text_size(theme.typography.fs_2xs)
                .child(category.label().to_uppercase()),
        );
        for candidate in SettingsPageId::ALL
            .into_iter()
            .filter(|candidate| candidate.category() == category)
        {
            let selected = candidate == page;
            let label: SharedString = candidate.label(platform).into();
            let copy: SharedString = candidate.copy(platform).into();
            let mut button = styled_settings_button(
                format!("settings-page-{}", candidate.id()),
                label.clone(),
                selected,
                disabled,
                selected,
                theme,
                cx,
            )
            .h(px(30.))
            .w_full()
            .px(spacing.s2)
            .justify_start()
            .accessibility_label(label.clone())
            .tooltip(copy);
            if let Some(callback) = callback.clone() {
                button = button.on_click(move |_, window, cx| {
                    callback(SettingsAction::SelectPage(candidate), window, cx);
                });
            }
            group = group.child(button);
        }
        nav = nav.child(group);
    }
    nav
}

fn category_color(category: SettingsCategory, colors: crate::theme::EmmaColors) -> Hsla {
    match category {
        SettingsCategory::Personal => colors.blue,
        SettingsCategory::Coding => colors.teal,
        SettingsCategory::Integrations => colors.violet,
        SettingsCategory::Emma => colors.lime,
    }
}

fn render_settings_body(
    page: SettingsPageId,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let mut body = v_flex()
        .id("settings-body")
        .flex_1()
        .h_full()
        .min_w_0()
        .min_h_0()
        .overflow_y_scroll()
        .items_center()
        .px(theme.dimensions.content_gutter_min)
        .pt(theme.spacing.s5)
        .pb(theme.spacing.s8);
    let content = match (&state.page, page) {
        (SettingsPageState::Keybinds(value), SettingsPageId::Keybinds) => {
            render_keybinds(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Notch(value), SettingsPageId::Notch) => {
            render_notch(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Voice(value), SettingsPageId::Voice) => {
            render_voice(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Appearance(value), SettingsPageId::Appearance) => {
            render_appearance(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::ContextBar(value), SettingsPageId::ContextBar) => {
            render_context_bar(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Models(value), SettingsPageId::Models) => {
            render_models(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Prompts(value), SettingsPageId::Prompts) => {
            render_prompts(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Tools(value), SettingsPageId::Tools) => {
            render_tools(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Permissions(value), SettingsPageId::Permissions) => {
            render_permissions(value, state, callback, theme, cx)
        }
        (SettingsPageState::Harness(value), SettingsPageId::Harness) => {
            render_harness(value, state, callback, theme, cx)
        }
        (SettingsPageState::Imports(value), SettingsPageId::Imports) => {
            render_imports(value, state, callback, theme, cx)
        }
        (SettingsPageState::Mobile(value), SettingsPageId::Mobile) => {
            render_mobile(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Built(value), SettingsPageId::Built) => {
            render_built(value, state, inputs, callback, theme, cx)
        }
        (SettingsPageState::Privacy(value), SettingsPageId::Privacy) => {
            render_privacy(value, state, callback, theme, cx)
        }
        (SettingsPageState::About(value), SettingsPageId::About) => {
            render_about(value, state, callback, theme, cx)
        }
        _ => render_mismatch(page, state, callback, theme, cx),
    };
    body = body.child(content);
    if let Some((kind, message)) = state.status.label() {
        body = body.child(status_banner(
            kind, message, state, page, callback, theme, cx,
        ));
    }
    if let ValidationState::Invalid(message) = &state.validation {
        body = body.child(error_banner(message.clone(), theme));
    }
    body.into_any_element()
}

fn render_mismatch(
    page: SettingsPageId,
    _state: &SettingsState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    section(
        format!("settings-mismatch-{}", page.id()),
        theme,
        v_flex()
            .gap(theme.spacing.s3)
            .child(mono_heading("Settings state unavailable", theme))
            .child(body_copy(
                "This page is waiting for its typed state. Retry to reload it without fabricating a successful save.",
                theme,
            ))
            .child(settings_button(
                "settings-mismatch-retry",
                "Retry",
                Some(SettingsAction::Retry(page)),
                callback,
                theme,
                cx,
                false,
                true,
            )),
    )
}

fn status_banner(
    kind: &'static str,
    message: SharedString,
    state: &SettingsState,
    page: SettingsPageId,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let color = match kind {
        "error" | "rollback" => theme.colors.danger,
        "disabled" => theme.colors.text_3,
        "loading" => theme.colors.orange,
        "ready" => theme.colors.lime,
        _ => theme.colors.text_2,
    };
    let mut row = h_flex()
        .id(format!("settings-status-{}", page.id()))
        .w(theme.dimensions.content_column)
        .max_w_full()
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_l_1()
        .border_color(color)
        .text_color(color)
        .text_size(theme.typography.fs_2xs)
        .child(message);
    if matches!(
        state.status,
        SettingsAsyncState::Error(_) | SettingsAsyncState::Rollback(_)
    ) {
        row = row.child(settings_button(
            format!("settings-status-retry-{}", page.id()),
            "Retry",
            Some(SettingsAction::Retry(page)),
            callback,
            theme,
            cx,
            false,
            false,
        ));
    }
    row.into_any_element()
}

fn error_banner(message: SharedString, theme: &EmmaTheme) -> AnyElement {
    div()
        .id("settings-validation-error")
        .w(theme.dimensions.content_column)
        .max_w_full()
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_l_1()
        .border_color(theme.colors.danger)
        .text_color(theme.colors.danger)
        .text_size(theme.typography.fs_sm)
        .child(message)
        .into_any_element()
}

fn page_frame(
    page: SettingsPageId,
    state: &SettingsState,
    theme: &EmmaTheme,
    children: impl IntoElement,
) -> AnyElement {
    let mut frame = v_flex()
        .id(format!("settings-page-{}-content", page.id()))
        .w(theme.dimensions.content_column)
        .max_w_full()
        .gap(theme.spacing.s5)
        .text_color(theme.colors.text)
        .when(state.disabled, |this| this.opacity(0.65))
        .child(page_header(page, state.platform, theme))
        .child(children);
    if page == SettingsPageId::ContextBar {
        frame = frame.w(px(980.));
    }
    frame.into_any_element()
}

fn page_header(page: SettingsPageId, platform: Platform, theme: &EmmaTheme) -> AnyElement {
    let breadcrumb = match page {
        SettingsPageId::Built => "Settings / built by Emma",
        SettingsPageId::ContextBar => "Settings / thread inspector",
        SettingsPageId::Models => "Settings / models & providers",
        SettingsPageId::Prompts | SettingsPageId::Harness => "Settings / coding harness",
        SettingsPageId::Tools | SettingsPageId::Imports => "Settings / extensions",
        SettingsPageId::Mobile => "Settings / paired devices",
        SettingsPageId::Privacy => "Settings / data boundaries",
        SettingsPageId::About => "Settings / about",
        _ => match page {
            SettingsPageId::Appearance => "Settings / appearance",
            SettingsPageId::Keybinds
            | SettingsPageId::Notch
            | SettingsPageId::Voice
            | SettingsPageId::Permissions => "Settings / local to this Mac",
            _ => "Settings",
        },
    };
    let breadcrumb = if platform == Platform::Windows
        && matches!(
            page,
            SettingsPageId::Keybinds
                | SettingsPageId::Notch
                | SettingsPageId::Voice
                | SettingsPageId::Permissions
        ) {
        breadcrumb.replace("Mac", "PC")
    } else {
        breadcrumb.to_string()
    };
    let title = match page {
        SettingsPageId::Keybinds => "Keybinds",
        SettingsPageId::Notch => {
            if platform == Platform::Windows {
                "Quick Ask"
            } else {
                "Notch"
            }
        }
        SettingsPageId::Voice => "Voice",
        SettingsPageId::Appearance => "Appearance",
        SettingsPageId::ContextBar => "Context bar",
        SettingsPageId::Models => "Models",
        SettingsPageId::Prompts => "System prompt",
        SettingsPageId::Tools => "Tools",
        SettingsPageId::Permissions => "Permissions",
        SettingsPageId::Harness => "Harness",
        SettingsPageId::Imports => "Imports & plugins",
        SettingsPageId::Mobile => "Mobile",
        SettingsPageId::Built => "Built by Emma",
        SettingsPageId::Privacy => "Data & privacy",
        SettingsPageId::About => "Emma",
    };
    let mut header = v_flex()
        .id(format!("settings-header-{}", page.id()))
        .gap(theme.spacing.s2)
        .pb(theme.spacing.s4)
        .border_b_1()
        .border_color(theme.colors.border_strong)
        .child(
            div()
                .text_color(theme.colors.text_3)
                .text_size(theme.typography.fs_2xs)
                .child(breadcrumb),
        )
        .child(
            div()
                .text_color(theme.colors.text)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_xl)
                .child(title),
        );
    if page == SettingsPageId::Built {
        header = header.child(body_copy(
            "Every piece Emma has built into her own interface, where you pointed her at it. Send one to a thread to work on it again, switch it off to hide it without losing it, or delete it for good.",
            theme,
        ));
    }
    header.into_any_element()
}

fn section(id: impl Into<ElementId>, theme: &EmmaTheme, children: impl IntoElement) -> AnyElement {
    v_flex()
        .id(id)
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(children)
        .into_any_element()
}

fn settings_row(
    id: impl Into<ElementId>,
    theme: &EmmaTheme,
    left: impl IntoElement,
    right: impl IntoElement,
) -> AnyElement {
    h_flex()
        .id(id)
        .w_full()
        .items_start()
        .gap(theme.spacing.s4)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_b_1()
        .border_color(theme.colors.border)
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(theme.spacing.s2)
                .child(left),
        )
        .child(
            v_flex()
                .w(px(232.))
                .flex_none()
                .gap(theme.spacing.s2)
                .child(right),
        )
        .into_any_element()
}

fn body_copy(value: impl Into<SharedString>, theme: &EmmaTheme) -> AnyElement {
    div()
        .text_color(theme.colors.text_2)
        .text_size(theme.typography.fs_sm)
        .line_height(relative(1.55))
        .child(value.into())
        .into_any_element()
}

fn mono_heading(value: impl Into<SharedString>, theme: &EmmaTheme) -> AnyElement {
    div()
        .text_color(theme.colors.text)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_sm)
        .line_height(relative(1.4))
        .child(value.into())
        .into_any_element()
}

fn mono_label(value: impl Into<SharedString>, theme: &EmmaTheme) -> AnyElement {
    div()
        .text_color(theme.colors.text_3)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .line_height(relative(1.4))
        .child(value.into())
        .into_any_element()
}

fn status_text(value: impl Into<SharedString>, live: bool, theme: &EmmaTheme) -> AnyElement {
    h_flex()
        .gap(theme.spacing.s2)
        .text_color(if live {
            theme.colors.lime
        } else {
            theme.colors.text_2
        })
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .child(if live { "●" } else { "·" })
        .child(value.into())
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn settings_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    action: Option<SettingsAction>,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
    primary: bool,
) -> Button {
    let label = label.into();
    let mut button = styled_settings_button(id, label.clone(), false, disabled, primary, theme, cx)
        .label(label.clone())
        .accessibility_label(label)
        .tab_index(0);
    if let (Some(action), Some(callback)) = (action, callback.clone()) {
        button = button.on_click(move |_, window, cx| {
            callback(action.clone(), window, cx);
        });
    }
    button
}

fn styled_settings_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    selected: bool,
    disabled: bool,
    primary: bool,
    theme: &EmmaTheme,
    cx: &mut App,
) -> Button {
    let colors = theme.colors;
    let surface = if selected {
        colors.surface_3
    } else {
        colors.text.alpha(0.)
    };
    let foreground = if selected || primary {
        colors.text
    } else {
        colors.text_2
    };
    let mut button = Button::new(id)
        .custom(
            ButtonCustomVariant::new(cx)
                .color(if primary { colors.accent_soft } else { surface })
                .foreground(if primary { colors.accent } else { foreground })
                .hover(colors.surface_2)
                .active(colors.surface_3)
                .shadow(false),
        )
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .font_normal()
        .label(label)
        .selected(selected)
        .toggled(selected);
    if disabled {
        button = button.disabled(true);
    }
    button
}

fn settings_checkbox(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    checked: bool,
    action: Option<SettingsAction>,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    disabled: bool,
) -> Checkbox {
    let label = label.into();
    let mut checkbox = Checkbox::new(id)
        .label(label.clone())
        .accessibility_label(label)
        .checked(checked)
        .disabled(disabled)
        .text_color(theme.colors.text)
        .text_size(theme.typography.fs_sm);
    if let (Some(action), Some(callback)) = (action, callback.clone()) {
        checkbox = checkbox.on_click(move |checked, window, cx| {
            let mut action = action.clone();
            action = replace_bool(action, *checked);
            callback(action, window, cx);
        });
    }
    checkbox
}

fn settings_switch(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    checked: bool,
    action: Option<SettingsAction>,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    disabled: bool,
) -> Switch {
    let label = label.into();
    let mut switch = Switch::new(id)
        .label(label.clone())
        .accessibility_label(label)
        .checked(checked)
        .disabled(disabled)
        .color(theme.colors.accent);
    if let (Some(action), Some(callback)) = (action, callback.clone()) {
        switch = switch.on_click(move |checked, window, cx| {
            let mut action = action.clone();
            action = replace_bool(action, *checked);
            callback(action, window, cx);
        });
    }
    switch
}

fn replace_bool(action: SettingsAction, value: bool) -> SettingsAction {
    match action {
        SettingsAction::Keybinds(KeybindAction::ToggleOrbs(_)) => {
            SettingsAction::Keybinds(KeybindAction::ToggleOrbs(value))
        }
        SettingsAction::Keybinds(KeybindAction::ToggleCommands(_)) => {
            SettingsAction::Keybinds(KeybindAction::ToggleCommands(value))
        }
        SettingsAction::Voice(VoiceAction::SetEnabled(_)) => {
            SettingsAction::Voice(VoiceAction::SetEnabled(value))
        }
        SettingsAction::Voice(VoiceAction::SetCleanup(_)) => {
            SettingsAction::Voice(VoiceAction::SetCleanup(value))
        }
        SettingsAction::Appearance(AppearanceAction::ToggleNavColors(_)) => {
            SettingsAction::Appearance(AppearanceAction::ToggleNavColors(value))
        }
        SettingsAction::Models(ModelsAction::SetPrivateRouting(_)) => {
            SettingsAction::Models(ModelsAction::SetPrivateRouting(value))
        }
        SettingsAction::Tools(ToolsAction::ToggleTool(id, _)) => {
            SettingsAction::Tools(ToolsAction::ToggleTool(id, value))
        }
        SettingsAction::Tools(ToolsAction::ToggleSkill(id, _)) => {
            SettingsAction::Tools(ToolsAction::ToggleSkill(id, value))
        }
        SettingsAction::Tools(ToolsAction::ToggleServer(id, _)) => {
            SettingsAction::Tools(ToolsAction::ToggleServer(id, value))
        }
        SettingsAction::Harness(HarnessAction::ToggleReinject(_)) => {
            SettingsAction::Harness(HarnessAction::ToggleReinject(value))
        }
        SettingsAction::Harness(HarnessAction::TogglePrune(_)) => {
            SettingsAction::Harness(HarnessAction::TogglePrune(value))
        }
        SettingsAction::Harness(HarnessAction::ToggleAutoCompact(_)) => {
            SettingsAction::Harness(HarnessAction::ToggleAutoCompact(value))
        }
        SettingsAction::Imports(ImportsAction::ToggleSource(id, _)) => {
            SettingsAction::Imports(ImportsAction::ToggleSource(id, value))
        }
        SettingsAction::Prompts(PromptsAction::TogglePreset(id, _)) => {
            SettingsAction::Prompts(PromptsAction::TogglePreset(id, value))
        }
        other => other,
    }
}

fn input_element(
    inputs: &SettingsInputs,
    id: InputId,
    label: impl Into<SharedString>,
    placeholder: impl Into<SharedString>,
    password: bool,
    disabled: bool,
    theme: &EmmaTheme,
) -> AnyElement {
    let label = label.into();
    if let Some(state) = inputs.single_line(id) {
        let mut input = Input::new(&state)
            .accessibility_id(format!("settings-input-{:?}", id))
            .aria_label(label)
            .h(px(28.))
            .appearance(true)
            .bordered(true)
            .focus_bordered(true)
            .disabled(disabled)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_sm)
            .text_color(theme.colors.text);
        if password {
            input = input.mask_toggle().content_type(InputContentType::Password);
        }
        input.into_any_element()
    } else {
        div()
            .id(format!("settings-input-missing-{:?}", id))
            .h(px(28.))
            .w_full()
            .px(theme.spacing.s2)
            .items_center()
            .border_1()
            .border_color(theme.colors.border)
            .text_color(theme.colors.text_3)
            .text_size(theme.typography.fs_sm)
            .child(placeholder.into())
            .into_any_element()
    }
}

fn textarea_element(
    inputs: &SettingsInputs,
    id: InputId,
    label: impl Into<SharedString>,
    disabled: bool,
    height: gpui::Pixels,
    theme: &EmmaTheme,
) -> AnyElement {
    if let Some(state) = inputs.textarea_state(id) {
        Textarea::new(&state)
            .aria_label(label)
            .h(height)
            .appearance(true)
            .bordered(true)
            .disabled(disabled)
            .font_family(theme.typography.font_code.clone())
            .text_size(theme.typography.fs_sm)
            .text_color(theme.colors.text)
            .into_any_element()
    } else {
        div()
            .id(format!("settings-textarea-missing-{:?}", id))
            .h(height)
            .w_full()
            .border_1()
            .border_color(theme.colors.border)
            .text_color(theme.colors.text_3)
            .child("Text input is unavailable")
            .into_any_element()
    }
}

#[allow(clippy::too_many_arguments)]
fn choice_group<T: Copy + Eq>(
    id: impl Into<SharedString>,
    options: &[T],
    selected: T,
    label: impl Fn(T) -> &'static str,
    action: impl Fn(T) -> SettingsAction,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let id = id.into();
    let mut row = h_flex().id(id.clone()).flex_wrap().gap(theme.spacing.s2);
    for option in options {
        let option = *option;
        row = row.child(settings_button(
            format!("{}-{}", id, label(option).replace(' ', "-")),
            label(option),
            Some(action(option)),
            callback,
            theme,
            cx,
            disabled,
            option == selected,
        ));
    }
    row.into_any_element()
}

fn mark(state: SetupMarkState, theme: &EmmaTheme) -> AnyElement {
    let (glyph, color) = match state {
        SetupMarkState::On => ("[ok]", theme.colors.accent),
        SetupMarkState::Off => ("[  ]", theme.colors.text_3),
        SetupMarkState::Unknown => ("[--]", theme.colors.text_3),
    };
    div()
        .text_color(color)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .child(glyph)
        .into_any_element()
}

pub fn validate_secret(value: &str) -> Result<(), SharedString> {
    if value.trim().is_empty() {
        return Err("A key is required before saving.".into());
    }
    if value.chars().count() > 512 {
        return Err("Keep a credential under 512 characters.".into());
    }
    Ok(())
}

pub fn validate_env_name(value: &str) -> Result<(), SharedString> {
    let value = value.trim();
    if value.is_empty()
        || !value
            .chars()
            .next()
            .is_some_and(|character| character == '_' || character.is_ascii_alphabetic())
        || !value
            .chars()
            .all(|character| character == '_' || character.is_ascii_alphanumeric())
        || value.len() > 64
    {
        return Err(
            "An environment variable name must start with a letter or underscore and hold only letters, digits, and underscores."
                .into(),
        );
    }
    Ok(())
}

pub fn validate_vault_folder(value: &str) -> Result<(), SharedString> {
    let value = value.trim();
    if value.is_empty()
        || value.len() > 128
        || value.starts_with('/')
        || value.contains("..")
        || value.contains('\\')
        || value
            .split('/')
            .any(|part| part.is_empty() || part == "." || part.starts_with('.'))
    {
        return Err("Choose a relative folder without hidden or parent segments.".into());
    }
    Ok(())
}

pub fn validate_provider_url(value: &str) -> Result<(), SharedString> {
    let value = value.trim();
    if !(value.starts_with("https://")
        || value.starts_with("http://127.0.0.1")
        || value.starts_with("http://localhost"))
    {
        return Err("The endpoint must use https, or http on this computer.".into());
    }
    Ok(())
}

fn render_keybinds(
    value: &KeybindsPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let mut shortcuts = v_flex()
        .id("keybind-shortcuts")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(
            h_flex()
                .items_baseline()
                .justify_between()
                .gap(theme.spacing.s4)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(
                    v_flex()
                        .gap(theme.spacing.s2)
                        .child(mono_heading("Shortcuts", theme))
                        .child(body_copy(
                            "A global shortcut is system-wide: whatever it takes, no other app can have it while Emma runs. The built-in gesture on a row is never taken away, so an empty row means no shortcut added — not no way in.",
                            theme,
                        )),
                )
                .child(mono_label(
                    if value.bound == 0 {
                        SharedString::from("NONE BOUND")
                    } else {
                        SharedString::from(format!("{} bound", value.bound))
                    },
                    theme,
                )),
        );
    for (index, shortcut) in value.shortcuts.iter().enumerate() {
        let mut controls = v_flex()
            .w(px(232.))
            .flex_none()
            .gap(theme.spacing.s2)
            .child(settings_button(
                format!("keybind-capture-{}", shortcut.id),
                if shortcut.recording {
                    "Press a combination, or hold one modifier… (Esc cancels)".into()
                } else {
                    shortcut
                        .key
                        .clone()
                        .unwrap_or_else(|| "Add a shortcut".into())
                },
                Some(SettingsAction::Keybinds(KeybindAction::Capture(
                    shortcut.id.clone(),
                ))),
                callback,
                theme,
                cx,
                disabled,
                shortcut.recording,
            ));
        if let Some(hold_ms) = shortcut.hold_ms {
            controls = controls.child(choice_group(
                format!("keybind-duration-{}", shortcut.id),
                &[300_u32, 500, 750, 1000],
                hold_ms,
                |duration| match duration {
                    300 => "Hold · 300ms",
                    500 => "Hold · 500ms",
                    750 => "Hold · 750ms",
                    _ => "Hold · 1000ms",
                },
                |duration| {
                    SettingsAction::Keybinds(KeybindAction::SetHoldMs(
                        shortcut.id.clone(),
                        duration,
                    ))
                },
                callback,
                theme,
                cx,
                disabled,
            ));
        }
        controls = controls.child(settings_button(
            format!("keybind-clear-{}", shortcut.id),
            "Clear",
            Some(SettingsAction::Keybinds(KeybindAction::Clear(
                shortcut.id.clone(),
            ))),
            callback,
            theme,
            cx,
            disabled || shortcut.key.is_none(),
            false,
        ));
        let left = h_flex()
            .w(px(34.))
            .h(px(34.))
            .flex_none()
            .items_center()
            .justify_center()
            .text_color(shortcut_color(index, theme))
            .font_family(theme.typography.font_code.clone())
            .text_size(theme.typography.fs_sm)
            .child(shortcut_glyph(index, shortcut));
        let mut description = v_flex()
            .flex_1()
            .min_w_0()
            .gap(theme.spacing.s2)
            .child(mono_heading(shortcut.label.clone(), theme))
            .child(body_copy(shortcut.detail.clone(), theme));
        if let Some(builtin) = shortcut.builtin.clone() {
            description = description.child(mono_label(
                format!("Built in, always on · {}", builtin),
                theme,
            ));
        }
        if shortcut.refused {
            description = description.child(
                div()
                    .text_color(theme.colors.orange)
                    .text_size(theme.typography.fs_2xs)
                    .child("Another app holds this shortcut. Pick a different one."),
            );
        }
        shortcuts = shortcuts.child(
            h_flex()
                .id(format!("keybind-row-{}", shortcut.id))
                .w_full()
                .items_start()
                .gap(theme.spacing.s4)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(left)
                .child(description)
                .child(controls),
        );
    }
    let mut quick_actions = v_flex()
        .id("keybind-quick-actions")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Quick actions",
            "Each one is a prompt the Quick Ask runs against whatever you hand it — a capture, the page your browser has in front, or nothing at all. Destination and category decide where the answer is filed when Save analyzed result is on.",
            format!("{}1 – {}3", state.platform.command(), state.platform.command()),
            theme,
        ));
    for (index, action) in value.quick_actions.iter().enumerate() {
        quick_actions = quick_actions.child(
            h_flex()
                .id(format!("quick-action-row-{}", index))
                .w_full()
                .items_start()
                .gap(theme.spacing.s4)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(
                    h_flex()
                        .w(px(34.))
                        .h(px(34.))
                        .flex_none()
                        .items_center()
                        .justify_center()
                        .text_color(shortcut_color(index + 3, theme))
                        .font_family(theme.typography.font_code.clone())
                        .text_size(theme.typography.fs_sm)
                        .child(format!("{}{}", state.platform.command(), index + 1)),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(theme.spacing.s2)
                        .child(field_label(
                            "Label",
                            input_element(
                                inputs,
                                InputId::QuickActionLabel(index as u8),
                                format!("Quick action {} label", index + 1),
                                action.label.clone(),
                                false,
                                disabled,
                                theme,
                            ),
                            theme,
                        ))
                        .child(field_label(
                            "Prompt",
                            textarea_element(
                                inputs,
                                InputId::QuickActionPrompt(index as u8),
                                format!("Quick action {} prompt", index + 1),
                                disabled,
                                px(70.),
                                theme,
                            ),
                            theme,
                        )),
                ),
        );
    }
    let mut orb_section = v_flex()
        .id("keybind-orbs")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Orbs you can rearrange",
            "The ring opens where the pointer is when Quick Ask does, and the same commands hang under the overlay when the pointer swipes below it. Save screen takes a picture of what you are looking at, reads it with your vision model, and asks the app in front what it is showing. Each save lands as one Markdown note in your vault, picture and all.",
            "ORBS",
            theme,
        ));
    orb_section = orb_section.child(
        v_flex()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .child(settings_checkbox(
                "orbs-enabled",
                "Ring the cursor when Quick Ask opens",
                value.orbs.enabled,
                Some(SettingsAction::Keybinds(KeybindAction::ToggleOrbs(
                    value.orbs.enabled,
                ))),
                callback,
                theme,
                disabled,
            ))
            .child(settings_checkbox(
                "commands-enabled",
                "Reveal commands under the overlay on a swipe",
                value.orbs.commands_enabled,
                Some(SettingsAction::Keybinds(KeybindAction::ToggleCommands(
                    value.orbs.commands_enabled,
                ))),
                callback,
                theme,
                disabled,
            ))
            .child(
                h_flex()
                    .gap(theme.spacing.s2)
                    .items_end()
                    .child(field_label(
                        "Orbs · 1–8",
                        div()
                            .id("orb-count")
                            .h(px(28.))
                            .w(px(80.))
                            .items_center()
                            .px(theme.spacing.s2)
                            .border_1()
                            .border_color(theme.colors.border_strong)
                            .text_color(theme.colors.text)
                            .text_size(theme.typography.fs_sm)
                            .child(value.orbs.commands.len().to_string()),
                        theme,
                    ))
                    .child(settings_button(
                        "orb-count-down",
                        "−",
                        Some(SettingsAction::Keybinds(KeybindAction::SetOrbCount(
                            value.orbs.commands.len().saturating_sub(1).max(1) as u8,
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled || value.orbs.commands.len() <= 1,
                        false,
                    ))
                    .child(settings_button(
                        "orb-count-up",
                        "+",
                        Some(SettingsAction::Keybinds(KeybindAction::SetOrbCount(
                            value.orbs.commands.len().saturating_add(1).min(8) as u8,
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled || value.orbs.commands.len() >= 8,
                        false,
                    )),
            )
            .child(mono_label(
                "Pick an orb to change what it runs or where it sits.",
                theme,
            )),
    );
    let mut orb_choices = h_flex()
        .id("orb-choices")
        .flex_wrap()
        .gap(theme.spacing.s2)
        .px(theme.spacing.s4)
        .pb(theme.spacing.s4);
    for (index, command) in value.orbs.commands.iter().enumerate() {
        orb_choices = orb_choices.child(settings_button(
            format!("orb-choice-{}", index),
            format!("Orb {} · {}", index + 1, command),
            Some(SettingsAction::Keybinds(KeybindAction::SelectOrb(index))),
            callback,
            theme,
            cx,
            disabled,
            value.orbs.selected == index,
        ));
    }
    orb_section = orb_section.child(orb_choices);
    let selected = match value.orbs.commands.get(value.orbs.selected) {
        Some(command) if command.as_ref() == "0" => "0",
        Some(command) if command.as_ref() == "1" => "1",
        Some(command) if command.as_ref() == "2" => "2",
        Some(command) if command.as_ref() == "screen" => "screen",
        Some(command) if command.as_ref() == "draw" => "draw",
        Some(command) if command.as_ref() == "keep" => "keep",
        Some(command) if command.as_ref() == "page" => "page",
        Some(command) if command.as_ref() == "workspace" => "workspace",
        _ => "screen",
    };
    orb_section = orb_section.child(
        h_flex()
            .gap(theme.spacing.s2)
            .items_end()
            .px(theme.spacing.s4)
            .pb(theme.spacing.s4)
            .child(mono_label("Orb runs", theme))
            .child(choice_group(
                "orb-command",
                &["0", "1", "2", "screen", "draw", "keep", "page", "workspace"],
                selected,
                |command| command,
                |command| SettingsAction::Keybinds(KeybindAction::SetOrbCommand(command.into())),
                callback,
                theme,
                cx,
                disabled,
            ))
            .child(settings_button(
                "orb-move-left",
                "↺",
                Some(SettingsAction::Keybinds(KeybindAction::MoveOrb(-1))),
                callback,
                theme,
                cx,
                disabled,
                false,
            ))
            .child(settings_button(
                "orb-move-right",
                "↻",
                Some(SettingsAction::Keybinds(KeybindAction::MoveOrb(1))),
                callback,
                theme,
                cx,
                disabled,
                false,
            )),
    );
    let children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(shortcuts)
        .child(quick_actions)
        .child(orb_section)
        .child(settings_button(
            "keybind-save",
            if value.saved {
                "Saved ✓"
            } else {
                "Save settings"
            },
            Some(SettingsAction::Keybinds(KeybindAction::Save)),
            callback,
            theme,
            cx,
            disabled,
            true,
        ));
    page_frame(SettingsPageId::Keybinds, state, theme, children)
}

fn shortcut_color(index: usize, theme: &EmmaTheme) -> Hsla {
    match index % 6 {
        0 => theme.colors.teal,
        1 => theme.colors.violet,
        2 => theme.colors.lime,
        3 => theme.colors.blue,
        4 => theme.colors.rose,
        _ => theme.colors.accent,
    }
}

fn shortcut_glyph(index: usize, shortcut: &ShortcutState) -> SharedString {
    shortcut.key.clone().unwrap_or_else(|| {
        if index < 4 {
            ["▭", "●", "✎", "⧉"][index].into()
        } else {
            format!("⌘{}", index - 3).into()
        }
    })
}

fn settings_section_header(
    title: impl Into<SharedString>,
    copy: impl Into<SharedString>,
    status: impl Into<SharedString>,
    theme: &EmmaTheme,
) -> AnyElement {
    h_flex()
        .items_baseline()
        .justify_between()
        .gap(theme.spacing.s4)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_b_1()
        .border_color(theme.colors.border)
        .child(
            v_flex()
                .flex_1()
                .min_w_0()
                .gap(theme.spacing.s2)
                .child(mono_heading(title, theme))
                .child(body_copy(copy, theme)),
        )
        .child(mono_label(status, theme))
        .into_any_element()
}

fn field_label(
    label: impl Into<SharedString>,
    child: impl IntoElement,
    theme: &EmmaTheme,
) -> AnyElement {
    v_flex()
        .gap(theme.spacing.s1)
        .child(mono_label(label, theme))
        .child(child)
        .into_any_element()
}

fn render_notch(
    value: &NotchPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let model_row = settings_row(
        "notch-model-row",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Quick Ask model", theme))
            .child(body_copy(
                "Emma pins this model and its provider to the thread the island creates, so Quick Ask and the workspace can use different routes at the same time. The island’s own picker writes this same setting while a model is pinned here.",
                theme,
            ))
            .child(mono_label("Decoupled from the composer’s picker.", theme)),
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_label("Quick Ask model", theme))
            .child(
                settings_button(
                    "notch-model",
                    if value.model.is_empty() {
                        "Workspace picker".into()
                    } else {
                        value.model.clone()
                    },
                    Some(SettingsAction::Notch(NotchAction::SelectModel(
                        value.model.clone(),
                    ))),
                    callback,
                    theme,
                    cx,
                    disabled,
                    false,
                )
                .w_full(),
            ),
    );
    let concurrency_row = settings_row(
        "notch-concurrency-row",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Shortcut while a task is running", theme))
            .child(body_copy(
                "A separate task leaves the running one where it is: it finishes in main and its answer lands in its own thread, which the workspace lists like any other. Carrying on instead reopens the running thread, so the next ask reads everything already said in it — and waits, because a thread runs one turn at a time.",
                theme,
            ))
            .child(mono_label("Pressing it again on a busy island.", theme)),
        choice_group(
            "notch-concurrency",
            &NotchConcurrency::ALL,
            value.concurrency,
            NotchConcurrency::label,
            |choice| SettingsAction::Notch(NotchAction::SetConcurrency(choice)),
            callback,
            theme,
            cx,
            disabled,
        ),
    );
    let position_copy = if state.platform == Platform::Windows {
        "Quick Ask appears as a small pill near the top of the display. Move it if the default position does not suit your taskbar or windows."
    } else {
        "Emma measures the real camera housing on each display and wraps the menu bar around it. The gap below is the fallback for Macs and external displays without a housing."
    };
    let position_row = settings_row(
        "notch-position-row",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading(
                if state.platform == Platform::Windows {
                    "Where Quick Ask appears"
                } else {
                    "Where the island hangs"
                },
                theme,
            ))
            .child(body_copy(position_copy, theme))
            .child(body_copy(
                if state.platform == Platform::Windows {
                    "Quick Ask appears near the top of the display."
                } else {
                    "Quick Ask hangs off the camera housing."
                },
                theme,
            )),
        field_label(
            "Fallback gap · 120–260 pt",
            input_element(
                inputs,
                InputId::NotchGap,
                "Fallback gap",
                value.notch_gap.to_string(),
                false,
                disabled,
                theme,
            ),
            theme,
        ),
    );
    let children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(section("notch-settings", theme, model_row))
        .child(section("notch-concurrency", theme, concurrency_row))
        .child(section("notch-position", theme, position_row));
    page_frame(SettingsPageId::Notch, state, theme, children)
}

fn render_voice(
    value: &VoicePageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let microphone_action = match value.microphone {
        PermissionStatus::Granted => VoiceAction::Refresh,
        PermissionStatus::NotDetermined | PermissionStatus::Unknown => {
            VoiceAction::RequestMicrophone
        }
        PermissionStatus::Denied | PermissionStatus::Restricted => VoiceAction::RequestMicrophone,
    };
    let microphone_button = match value.microphone {
        PermissionStatus::Granted => "Re-check",
        PermissionStatus::NotDetermined | PermissionStatus::Unknown => "Ask for the microphone",
        PermissionStatus::Denied | PermissionStatus::Restricted => "Open System Settings ↗",
    };
    let microphone_row = settings_row(
        "voice-microphone",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("1 · Microphone", theme))
            .child(body_copy(
                format!(
                    "{} asks the first time Emma records, and only you can answer. Nothing is captured until you hold the key or press the button below, and the recording goes to a server on this {} and nowhere else.",
                    state.platform.name(),
                    state.platform.device()
                ),
                theme,
            )),
        v_flex()
            .gap(theme.spacing.s2)
            .child(status_text(
                value.microphone.label(state.platform),
                value.microphone == PermissionStatus::Granted,
                theme,
            ))
            .child(settings_button(
                "voice-microphone-action",
                microphone_button,
                Some(SettingsAction::Voice(microphone_action)),
                callback,
                theme,
                cx,
                disabled,
                false,
            )),
    );
    let speech_copy = match value.engine {
        TranscriptionEngine::Apple => {
            if state.platform == Platform::Windows {
                "Windows includes the SAPI speech recognizer, so Emma can ask it directly. Nothing to install, nothing to keep running. Recognition stays on this PC, and the recording never leaves it."
            } else {
                "macOS already has a speech recognizer — the one system dictation uses — and Emma can just ask it. Nothing to install, nothing to keep running. Emma pins it to on-device recognition, so the recording never leaves this computer; it needs Dictation switched on under System Settings → Keyboard, which is what downloads the model."
            }
        }
        TranscriptionEngine::Server => {
            "Both halves of voice run on llama.cpp — using the native acceleration available on your computer, and its server speaks the two OpenAI routes this needs. Install it once, then start the speech server on ggml-org/Qwen3-ASR-0.6B-GGUF; the first run downloads the weights."
        }
    };
    let mut speech_right = v_flex()
        .gap(theme.spacing.s2)
        .child(status_text(
            if value.speech_ready {
                if value.engine == TranscriptionEngine::Apple {
                    "Ready"
                } else {
                    "Answering"
                }
            } else {
                "Not running"
            },
            value.speech_ready,
            theme,
        ))
        .child(choice_group(
            "voice-engine",
            &TranscriptionEngine::ALL,
            value.engine,
            {
                let platform = state.platform;
                move |engine| engine.label(platform)
            },
            |engine| SettingsAction::Voice(VoiceAction::SetEngine(engine)),
            callback,
            theme,
            cx,
            disabled,
        ));
    if value.engine == TranscriptionEngine::Server {
        speech_right = speech_right
            .child(field_label(
                "Endpoint",
                input_element(
                    inputs,
                    InputId::VoiceEndpoint,
                    "Speech endpoint",
                    "http://127.0.0.1:8080/v1/audio/transcriptions",
                    false,
                    disabled,
                    theme,
                ),
                theme,
            ))
            .child(field_label(
                "Model",
                input_element(
                    inputs,
                    InputId::VoiceModel,
                    "Speech model",
                    "ggml-org/Qwen3-ASR-0.6B-GGUF",
                    false,
                    disabled,
                    theme,
                ),
                theme,
            ));
    }
    if let Some(error) = value.speech_error.clone() {
        speech_right = speech_right.child(
            div()
                .text_color(theme.colors.danger)
                .text_size(theme.typography.fs_2xs)
                .child(error),
        );
    }
    speech_right = speech_right
        .child(settings_button(
            "voice-refresh",
            "Check again",
            Some(SettingsAction::Voice(VoiceAction::Refresh)),
            callback,
            theme,
            cx,
            disabled,
            false,
        ))
        .child(settings_button(
            "voice-speech-settings",
            if state.platform == Platform::Windows {
                "Speech settings ↗"
            } else {
                "Speech Recognition ↗"
            },
            Some(SettingsAction::Voice(VoiceAction::OpenSpeechSettings)),
            callback,
            theme,
            cx,
            disabled,
            false,
        ));
    let speech_row = settings_row(
        "voice-speech",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("2 · Speech to text", theme))
            .child(body_copy(speech_copy, theme))
            .child(body_copy(
                "The llama.cpp route hears more accurately, especially names and technical words. Switch engines here if you would rather run a server.",
                theme,
            ))
            .child(settings_checkbox(
                "voice-enabled",
                "Voice input on — hold space in Quick Ask to dictate",
                value.transcription_enabled,
                Some(SettingsAction::Voice(VoiceAction::SetEnabled(
                    value.transcription_enabled,
                ))),
                callback,
                theme,
                disabled,
            )),
        speech_right,
    );
    let cleanup_row = settings_row(
        "voice-cleanup",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("3 · Clean the transcript up · optional", theme))
            .child(body_copy(
                "superwhisper/s1-mini-GGUF is a 0.6B text model that rewrites a raw transcript as written English: fillers dropped, false starts resolved, punctuation, numbers and dates rendered properly. It hears nothing — it reads what the speech server heard — so it is the second half of the pipeline, never the first. A second llama-server, on the Q4_K_M build, 462 MB.",
                theme,
            ))
            .child(body_copy(
                "The flags matter: S1-mini was trained with thinking off and greedy decoding, and the file's own metadata says otherwise. Emma sends both again on every request.",
                theme,
            ))
            .child(settings_checkbox(
                "voice-cleanup-enabled",
                "Clean transcripts up when the model is available",
                value.cleanup_enabled,
                Some(SettingsAction::Voice(VoiceAction::SetCleanup(
                    value.cleanup_enabled,
                ))),
                callback,
                theme,
                disabled,
            )),
        v_flex()
            .gap(theme.spacing.s2)
            .child(status_text(
                if value.cleanup_model_loaded {
                    "Model loaded"
                } else if value.cleanup_running {
                    "Server running · S1-mini not loaded"
                } else {
                    "Not running"
                },
                value.cleanup_model_loaded,
                theme,
            ))
            .child(field_label(
                "Endpoint",
                input_element(
                    inputs,
                    InputId::CleanupEndpoint,
                    "Cleanup endpoint",
                    "http://127.0.0.1:8081/v1/chat/completions",
                    false,
                    disabled,
                    theme,
                ),
                theme,
            ))
            .child(field_label(
                "Model",
                input_element(
                    inputs,
                    InputId::CleanupModel,
                    "Cleanup model",
                    "superwhisper/s1-mini-GGUF",
                    false,
                    disabled,
                    theme,
                ),
                theme,
            ))
            .when(!value.serving_models.is_empty(), |this| {
                this.child(mono_label(
                    format!(
                        "Serving {}: {}",
                        value.serving_models.len(),
                        value
                            .serving_models
                            .iter()
                            .take(3)
                            .map(ToString::to_string)
                            .collect::<Vec<_>>()
                            .join(", ")
                    ),
                    theme,
                ))
            })
            .child(mono_label("A cleanup that fails keeps the raw words", theme)),
    );
    let hold_row = settings_row(
        "voice-hold",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("4 · Hold to talk", theme))
            .child(body_copy(
                "In Quick Ask, hold the space bar while the box is empty, say your piece, and let go — Emma types what you said. A tap is still just a tap. The same is on the ● button, and on the Quick Ask with voice keybind.",
                theme,
            )),
        choice_group(
            "voice-hold-duration",
            &[200_u16, 300, 400, 600, 800],
            value.hold_ms,
            |duration| match duration {
                200 => "200ms",
                300 => "300ms",
                400 => "400ms",
                600 => "600ms",
                _ => "800ms",
            },
            |duration| SettingsAction::Voice(VoiceAction::SetHoldMs(duration)),
            callback,
            theme,
            cx,
            disabled,
        ),
    );
    let mut try_left = v_flex()
        .gap(theme.spacing.s2)
        .child(mono_heading("5 · Try it", theme))
        .child(body_copy(
            "Press and hold, say something, and let go. This is the whole path the Quick Ask uses, so what comes back here is what it would have typed.",
            theme,
        ));
    if let Some(error) = value.speech_error.clone() {
        try_left = try_left.child(
            div()
                .text_color(theme.colors.danger)
                .text_size(theme.typography.fs_2xs)
                .child(error),
        );
    }
    if let Some(heard) = value.heard.clone() {
        try_left = try_left.child(body_copy(format!("“{}”", heard), theme));
    }
    let try_row = settings_row(
        "voice-try",
        theme,
        try_left,
        settings_button(
            "voice-try-button",
            "Hold to talk",
            Some(SettingsAction::Voice(VoiceAction::StartTry)),
            callback,
            theme,
            cx,
            disabled || value.microphone == PermissionStatus::Denied,
            false,
        ),
    );
    let children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(section("voice-microphone-section", theme, microphone_row))
        .child(section("voice-speech-section", theme, speech_row))
        .child(section("voice-cleanup-section", theme, cleanup_row))
        .child(section("voice-hold-section", theme, hold_row))
        .child(section("voice-try-section", theme, try_row));
    page_frame(SettingsPageId::Voice, state, theme, children)
}

fn render_appearance(
    value: &AppearancePageState,
    state: &SettingsState,
    _inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let accent_copy = "The one hue that means action: primary buttons, the focus ring, a checked control, and any figure meant to read as data.";
    let mut accents = h_flex()
        .id("appearance-accent-choices")
        .flex_wrap()
        .gap(theme.spacing.s2);
    for accent in AccentChoice::ALL.iter().cloned() {
        let selected = value.accent == accent;
        let color = accent_color(accent.id(), theme);
        let mut button = settings_button(
            format!("accent-{}", accent.id()),
            accent.label(),
            Some(SettingsAction::Appearance(AppearanceAction::SetAccent(
                accent.clone(),
            ))),
            callback,
            theme,
            cx,
            disabled,
            selected,
        )
        .size(px(30.))
        .text_color(color);
        if selected {
            button = button.border_color(theme.colors.text);
        }
        accents = accents.child(button);
    }
    let custom_label = match &value.accent {
        AccentChoice::Custom(hex) => format!("Any colour · {}", hex),
        _ => "Any colour".to_string(),
    };
    accents = accents.child(settings_button(
        "accent-custom",
        custom_label,
        Some(SettingsAction::Appearance(AppearanceAction::SetAccent(
            AccentChoice::Custom("#ff6a3d".into()),
        ))),
        callback,
        theme,
        cx,
        disabled,
        matches!(value.accent, AccentChoice::Custom(_)),
    ));
    let accent_row = settings_row(
        "appearance-accent-row",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Accent", theme))
            .child(body_copy(accent_copy, theme)),
        v_flex()
            .gap(theme.spacing.s2)
            .child(accents)
            .child(mono_label(
                value.accent.clone().label().to_ascii_uppercase(),
                theme,
            )),
    );
    let scale = h_flex()
        .gap(theme.spacing.s2)
        .items_center()
        .child(settings_button(
            "appearance-scale-down",
            "−",
            Some(SettingsAction::Appearance(AppearanceAction::SetScale(
                value.ui_scale.saturating_sub(5).max(80),
            ))),
            callback,
            theme,
            cx,
            disabled || value.ui_scale <= 80,
            false,
        ))
        .child(
            div()
                .id("appearance-scale-value")
                .min_w(px(76.))
                .text_color(theme.colors.text)
                .text_size(theme.typography.fs_sm)
                .child(format!("Scale · {}%", value.ui_scale)),
        )
        .child(settings_button(
            "appearance-scale-up",
            "+",
            Some(SettingsAction::Appearance(AppearanceAction::SetScale(
                value.ui_scale.saturating_add(5).min(150),
            ))),
            callback,
            theme,
            cx,
            disabled || value.ui_scale >= 150,
            false,
        ));
    let scale_row = settings_row(
        "appearance-scale-row",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Interface scale", theme))
            .child(body_copy(
                "Zooms the whole window the way a browser does, from 80% to 150%. Everything scales together — type, rules, and spacing.",
                theme,
            )),
        scale,
    );
    let width_row = settings_row(
        "appearance-conversation-width",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Conversation width", theme))
            .child(body_copy(
                "How wide a thread reads. Wider pays off with the sidebar and the context bar closed; the composer keeps its own width.",
                theme,
            )),
        choice_group(
            "conversation-width-choice",
            &ConversationWidth::ALL,
            value.conversation_width,
            ConversationWidth::label,
            |width| SettingsAction::Appearance(AppearanceAction::SetConversationWidth(width)),
            callback,
            theme,
            cx,
            disabled,
        ),
    );
    let mut nav_hues = h_flex()
        .id("appearance-nav-hues")
        .flex_wrap()
        .gap(theme.spacing.s2);
    for (id, accent) in &value.nav_hues {
        nav_hues = nav_hues.child(settings_button(
            format!("nav-hue-{}", id),
            format!("{} · {}", id, accent.label()),
            Some(SettingsAction::Appearance(AppearanceAction::SetNavHue(
                id.clone(),
                accent.clone(),
            ))),
            callback,
            theme,
            cx,
            disabled || !value.nav_icon_colors,
            false,
        ));
    }
    nav_hues = nav_hues.child(settings_button(
        "nav-hue-reset",
        "Reset",
        Some(SettingsAction::Appearance(AppearanceAction::ResetNavHues)),
        callback,
        theme,
        cx,
        disabled || value.nav_hues.is_empty(),
        false,
    ));
    let nav_row = settings_row(
        "appearance-nav-row",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Section marks", theme))
            .child(body_copy(
                "A hue each for the sidebar’s section marks. Off, they all draw in the same grey as their labels.",
                theme,
            ))
            .child(settings_checkbox(
                "appearance-nav-colors",
                "Colour the section marks",
                value.nav_icon_colors,
                Some(SettingsAction::Appearance(AppearanceAction::ToggleNavColors(
                    value.nav_icon_colors,
                ))),
                callback,
                theme,
                disabled,
            )),
        nav_hues,
    );
    let interface_row = settings_row(
        "appearance-interface-font",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Interface font", theme))
            .child(body_copy(
                "Everything on the grid: the sidebar, tabs, buttons, model picker, and every label in Settings.",
                theme,
            )),
        choice_group(
            "interface-font-choice",
            &FontChoice::ALL,
            value.interface_font,
            FontChoice::label,
            |font| SettingsAction::Appearance(AppearanceAction::SetInterfaceFont(font)),
            callback,
            theme,
            cx,
            disabled,
        ),
    );
    let agent_row = settings_row(
        "appearance-agent-font",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Agent font", theme))
            .child(body_copy(
                "What the agent writes in a thread, plus the composer you answer it in.",
                theme,
            )),
        v_flex()
            .gap(theme.spacing.s2)
            .child(choice_group(
                "agent-font-choice",
                &FontChoice::ALL,
                value.agent_font,
                FontChoice::label,
                |font| SettingsAction::Appearance(AppearanceAction::SetAgentFont(font)),
                callback,
                theme,
                cx,
                disabled,
            ))
            .child(body_copy(
                "The quick brown fox jumps over the lazy dog.",
                theme,
            )),
    );
    let children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(section("appearance-accent", theme, accent_row))
        .child(section("appearance-scale", theme, scale_row))
        .child(section("appearance-width", theme, width_row))
        .child(section("appearance-nav", theme, nav_row))
        .child(section("appearance-interface", theme, interface_row))
        .child(section("appearance-agent", theme, agent_row))
        .child(settings_button(
            "appearance-save",
            "Save settings",
            Some(SettingsAction::Appearance(AppearanceAction::Save)),
            callback,
            theme,
            cx,
            disabled,
            true,
        ));
    page_frame(SettingsPageId::Appearance, state, theme, children)
}

fn accent_color(id: &str, theme: &EmmaTheme) -> Hsla {
    match id {
        "rose" => theme.colors.rose,
        "lime" => theme.colors.lime,
        "teal" => theme.colors.teal,
        "blue" => theme.colors.blue,
        "violet" => theme.colors.violet,
        _ => theme.colors.orange,
    }
}

fn render_context_bar(
    value: &ContextBarPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let active = value.active.min(value.pages.len().saturating_sub(1));
    let page = value.pages.get(active);
    let mut tabs = h_flex()
        .id("context-bar-tabs")
        .flex_wrap()
        .gap(theme.spacing.s2);
    for (index, item) in value.pages.iter().enumerate() {
        tabs = tabs.child(settings_button(
            format!("context-page-{}", item.id),
            item.name.clone(),
            Some(SettingsAction::ContextBar(ContextBarAction::SelectPage(
                index,
            ))),
            callback,
            theme,
            cx,
            disabled,
            index == active,
        ));
    }
    let page_picker = section(
        "context-bar-pages",
        theme,
        v_flex()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(mono_label(
                        format!("Pages · {} of 4", value.pages.len()),
                        theme,
                    ))
                    .child(settings_button(
                        "context-add-page",
                        "New page",
                        Some(SettingsAction::ContextBar(ContextBarAction::AddPage)),
                        callback,
                        theme,
                        cx,
                        disabled || value.pages.len() >= 4,
                        false,
                    )),
            )
            .child(tabs)
            .when_some(page, |this, page| {
                this.child(
                    h_flex()
                        .items_end()
                        .gap(theme.spacing.s2)
                        .child(field_label(
                            "Name",
                            input_element(
                                inputs,
                                InputId::PromptName(active as u16),
                                "Context page name",
                                page.name.clone(),
                                false,
                                disabled,
                                theme,
                            ),
                            theme,
                        ))
                        .child(settings_button(
                            "context-delete-page",
                            "Delete page",
                            Some(SettingsAction::ContextBar(ContextBarAction::DeletePage)),
                            callback,
                            theme,
                            cx,
                            disabled || value.pages.len() < 2,
                            false,
                        )),
                )
            }),
    );
    let mut palette = v_flex()
        .id("context-palette")
        .w(px(280.))
        .flex_none()
        .gap(theme.spacing.s2)
        .border_1()
        .border_color(theme.colors.border_strong)
        .p(theme.spacing.s4)
        .child(mono_label("Components", theme));
    let widget_catalog = [
        ("stats", "Thread stats", "▦"),
        ("context", "Context window", "▤"),
        ("timeline", "Timeline", "⌇"),
        ("tasklist", "Tasks", "☷"),
        ("plan", "Plan", "◰"),
        ("subagents", "Subagents", "⌸"),
        ("subthreads", "Sub threads", "⑃"),
        ("machine", "Machine", "◫"),
        ("machinegraph", "Machine graph", "∿"),
        ("machinemeters", "Machine meters", "▥"),
        ("git", "Git", "⑂"),
    ];
    for (id, label, glyph) in widget_catalog {
        let on_page = page.is_some_and(|page| page.widgets.iter().any(|item| item.as_ref() == id));
        palette = palette.child(
            h_flex()
                .gap(theme.spacing.s2)
                .items_center()
                .child(
                    div()
                        .w(px(20.))
                        .text_color(theme.colors.accent)
                        .child(glyph),
                )
                .child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .text_color(theme.colors.text)
                        .text_size(theme.typography.fs_sm)
                        .child(label),
                )
                .child(settings_button(
                    format!("context-add-widget-{}", id),
                    if on_page { "On page" } else { "+" },
                    Some(SettingsAction::ContextBar(ContextBarAction::AddWidget(
                        id.into(),
                    ))),
                    callback,
                    theme,
                    cx,
                    disabled || on_page,
                    false,
                )),
        );
    }
    let mut stage = v_flex()
        .id("context-stage")
        .flex_1()
        .min_w_0()
        .gap(theme.spacing.s3)
        .border_1()
        .border_color(theme.colors.border_strong)
        .p(theme.spacing.s4)
        .child(
            h_flex().justify_between().child(mono_label(
                page.map(|item| item.name.clone())
                    .unwrap_or_else(|| "Context".into()),
                theme,
            )),
        )
        .child(
            v_flex()
                .id("context-preview")
                .min_h(px(288.))
                .gap(theme.spacing.s2)
                .border_1()
                .border_color(theme.colors.border)
                .p(theme.spacing.s4),
        );
    if let Some(page) = page {
        let mut widgets = v_flex().gap(theme.spacing.s2);
        for (index, widget) in page.widgets.iter().enumerate() {
            widgets = widgets.child(
                h_flex()
                    .id(format!("context-widget-{}", widget))
                    .items_center()
                    .gap(theme.spacing.s2)
                    .px(theme.spacing.s2)
                    .py(theme.spacing.s2)
                    .border_1()
                    .border_color(theme.colors.border)
                    .child(mono_heading(widget.clone(), theme))
                    .child(settings_button(
                        format!("context-widget-up-{}", index),
                        "↑",
                        Some(SettingsAction::ContextBar(ContextBarAction::MoveWidget(
                            widget.clone(),
                            -1,
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled || index == 0,
                        false,
                    ))
                    .child(settings_button(
                        format!("context-widget-down-{}", index),
                        "↓",
                        Some(SettingsAction::ContextBar(ContextBarAction::MoveWidget(
                            widget.clone(),
                            1,
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled || index + 1 == page.widgets.len(),
                        false,
                    ))
                    .child(settings_button(
                        format!("context-widget-remove-{}", index),
                        "×",
                        Some(SettingsAction::ContextBar(ContextBarAction::RemoveWidget(
                            widget.clone(),
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled,
                        false,
                    )),
            );
        }
        stage = stage.child(widgets);
    } else {
        stage = stage.child(body_copy(
            "Drag a component in, or press its ＋. An empty page shows the thread's name and nothing else.",
            theme,
        ));
    }
    let workbench = h_flex()
        .id("context-workbench")
        .w_full()
        .items_start()
        .gap(theme.spacing.s4)
        .child(palette)
        .child(stage);
    let children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(page_picker)
        .child(workbench);
    page_frame(SettingsPageId::ContextBar, state, theme, children)
}

fn render_models(
    value: &ModelsPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let catalog_header = settings_section_header(
        "Choose a model, star up to 6",
        "Model catalog",
        format!(
            "{} / 6 starred",
            value.catalog.iter().filter(|item| item.starred).count()
        ),
        theme,
    );
    let catalog_search = field_label(
        "Search the model catalog",
        input_element(
            inputs,
            InputId::ModelsSearch,
            "Search models by name or ID",
            "Search models by name or ID",
            false,
            disabled,
            theme,
        ),
        theme,
    );
    let mut catalog = v_flex()
        .id("model-catalog-list")
        .w_full()
        .gap(theme.spacing.s2)
        .child(catalog_header)
        .child(catalog_search);
    for (index, model) in value.catalog.iter().enumerate() {
        let mut row = h_flex()
            .id(format!("model-{}", model.id))
            .w_full()
            .min_h(px(36.))
            .items_center()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s2)
            .border_b_1()
            .border_color(theme.colors.border)
            .when(model.active, |this| this.bg(theme.colors.surface_3))
            .child(
                div()
                    .w(px(20.))
                    .text_color(model_color(&model.maker, theme))
                    .child(model.maker.clone()),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(px(1.))
                    .child(mono_heading(model.name.clone(), theme))
                    .child(mono_label(model.detail.clone(), theme)),
            );
        if model.free {
            row = row.child(
                div()
                    .text_color(theme.colors.accent)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_2xs)
                    .child("FREE"),
            );
        }
        row = row
            .child(settings_button(
                format!("model-star-{}", model.id),
                if model.starred { "★" } else { "☆" },
                Some(SettingsAction::Models(ModelsAction::ToggleFavorite(
                    model.id.clone(),
                ))),
                callback,
                theme,
                cx,
                disabled,
                model.starred,
            ))
            .child(settings_button(
                format!("model-use-{}", model.id),
                if model.active { "Active" } else { "Use" },
                Some(SettingsAction::Models(ModelsAction::SelectModel(
                    model.id.clone(),
                ))),
                callback,
                theme,
                cx,
                disabled || model.active,
                model.active,
            ));
        catalog = catalog.child(row);
        if index >= 29 {
            break;
        }
    }
    if value.catalog.is_empty() {
        catalog = catalog.child(body_copy("No models under this maker.", theme));
    }
    catalog = catalog.child(
        h_flex()
            .gap(theme.spacing.s2)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .child(mono_label(async_status_line(&value.catalog_status), theme))
            .child(settings_button(
                "model-reload",
                "Reload model catalogs",
                Some(SettingsAction::Models(ModelsAction::ReloadCatalog)),
                callback,
                theme,
                cx,
                disabled || matches!(value.catalog_status, SettingsAsyncState::Loading),
                false,
            )),
    );
    let mut provider_form = v_flex()
        .id("provider-form")
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .child(h_flex().gap(theme.spacing.s2).flex_wrap().children([
            settings_button(
                "provider-preset-openrouter",
                "OpenRouter",
                Some(SettingsAction::Models(ModelsAction::AddProvider)),
                callback,
                theme,
                cx,
                disabled,
                false,
            ),
            settings_button(
                "provider-preset-local",
                "Local endpoint",
                Some(SettingsAction::Models(ModelsAction::AddProvider)),
                callback,
                theme,
                cx,
                disabled,
                false,
            ),
        ]))
        .child(
            h_flex()
                .gap(theme.spacing.s3)
                .items_end()
                .child(field_label(
                    "Name",
                    input_element(
                        inputs,
                        InputId::ProviderName,
                        "Provider name",
                        "Mac Studio",
                        false,
                        disabled,
                        theme,
                    ),
                    theme,
                ))
                .child(field_label(
                    "Base URL",
                    input_element(
                        inputs,
                        InputId::ProviderBaseUrl,
                        "Provider base URL",
                        "http://127.0.0.1:1234/v1",
                        false,
                        disabled,
                        theme,
                    ),
                    theme,
                ))
                .child(field_label(
                    "Model ID",
                    input_element(
                        inputs,
                        InputId::ProviderModelId,
                        "Provider model ID",
                        "qwen3-8b",
                        false,
                        disabled,
                        theme,
                    ),
                    theme,
                )),
        )
        .child(
            h_flex()
                .gap(theme.spacing.s3)
                .items_end()
                .child(field_label(
                    "Key env",
                    input_element(
                        inputs,
                        InputId::ProviderCredentialEnv,
                        "Provider key environment variable",
                        "Optional · DEEPSEEK_API_KEY",
                        false,
                        disabled,
                        theme,
                    ),
                    theme,
                ))
                .child(field_label(
                    "Context window",
                    input_element(
                        inputs,
                        InputId::ProviderContextWindow,
                        "Provider context window",
                        "Optional · 131072",
                        false,
                        disabled,
                        theme,
                    ),
                    theme,
                ))
                .child(settings_button(
                    "provider-test",
                    "Test",
                    Some(SettingsAction::Models(ModelsAction::TestProvider)),
                    callback,
                    theme,
                    cx,
                    disabled,
                    false,
                ))
                .child(settings_button(
                    "provider-add",
                    "Add provider",
                    Some(SettingsAction::Models(ModelsAction::AddProvider)),
                    callback,
                    theme,
                    cx,
                    disabled,
                    true,
                )),
        );
    for provider in &value.providers {
        provider_form = provider_form.child(
            h_flex()
                .id(format!("provider-row-{}", provider.id))
                .items_center()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_t_1()
                .border_color(theme.colors.border)
                .when(provider.active, |this| this.bg(theme.colors.surface_3))
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(1.))
                        .child(mono_heading(provider.name.clone(), theme))
                        .child(mono_label(
                            format!(
                                "{} · {} · {}",
                                provider.model_id, provider.base_url, provider.reach
                            ),
                            theme,
                        )),
                )
                .child(settings_button(
                    format!("provider-select-{}", provider.id),
                    if provider.active { "Active" } else { "Use" },
                    Some(SettingsAction::Models(ModelsAction::SelectProvider(
                        provider.id.clone(),
                    ))),
                    callback,
                    theme,
                    cx,
                    disabled || provider.active,
                    provider.active,
                ))
                .child(settings_button(
                    format!("provider-remove-{}", provider.id),
                    "Remove",
                    Some(SettingsAction::Models(ModelsAction::RemoveProvider(
                        provider.id.clone(),
                    ))),
                    callback,
                    theme,
                    cx,
                    disabled || provider.active,
                    false,
                )),
        );
    }
    let provider_section = section(
        "models-providers",
        theme,
        v_flex()
            .child(settings_section_header(
                "Any OpenAI-compatible endpoint",
                "Providers",
                format!("{} saved", value.providers.len()),
                theme,
            ))
            .child(provider_form),
    );
    let verifier = model_role_section(
        "Verifier · clears a call in Auto",
        "A small, cheap second model that allows or blocks each gated call. Leave it off and Auto asks you.",
        "Verifier",
        &value.verifier,
        InputId::VerifierRules,
        ModelsAction::SaveVerifier,
        callback,
        inputs,
        state,
        theme,
        cx,
    );
    let advisor = model_role_section(
        "Advisor · asked when the agent is stuck",
        "A stronger second model the agent asks for a plan when it is stuck.",
        "Advisor",
        &value.advisor,
        InputId::AdvisorRules,
        ModelsAction::SaveAdvisor,
        callback,
        inputs,
        state,
        theme,
        cx,
    );
    let vision = model_role_section(
        "Vision · asked to look at an image",
        "The model the agent sends an image to. Only models that can see are listed.",
        "Vision",
        &value.vision,
        InputId::VisionRules,
        ModelsAction::SaveVision,
        callback,
        inputs,
        state,
        theme,
        cx,
    );
    let secret = model_role_section(
        "Secrets · the only model your keys reach",
        "Where the agent sends keys, tokens and vault entries. Nothing else sees them.",
        "Secrets",
        &value.secret,
        InputId::SecretRules,
        ModelsAction::SaveSecret,
        callback,
        inputs,
        state,
        theme,
        cx,
    );
    let mut keys = v_flex()
        .id("provider-keys")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Keys stay in the secure store",
            "API keys",
            format!(
                "{} stored",
                value
                    .credentials
                    .iter()
                    .filter(|item| item.masked.is_some())
                    .count()
            ),
            theme,
        ));
    for (index, credential) in value.credentials.iter().enumerate() {
        let masked = credential
            .masked
            .clone()
            .unwrap_or_else(|| "Not set".into());
        keys = keys.child(
            h_flex()
                .id(format!("credential-row-{}", credential.env))
                .items_center()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(px(1.))
                        .child(mono_heading(credential.label.clone(), theme))
                        .child(mono_label(
                            format!("{} · {}", credential.detail, credential.env),
                            theme,
                        )),
                )
                .child(mono_label(masked, theme))
                .child(field_label(
                    "API key",
                    input_element(
                        inputs,
                        InputId::Credential(index as u16),
                        "Credential",
                        "Paste a replacement",
                        true,
                        disabled,
                        theme,
                    ),
                    theme,
                ))
                .child(settings_button(
                    format!("credential-save-{}", credential.env),
                    "Save",
                    Some(SettingsAction::Models(ModelsAction::SaveCredential(
                        credential.env.clone(),
                    ))),
                    callback,
                    theme,
                    cx,
                    disabled,
                    true,
                ))
                .child(settings_button(
                    format!("credential-remove-{}", credential.env),
                    "Remove",
                    Some(SettingsAction::Models(ModelsAction::RemoveCredential(
                        credential.env.clone(),
                    ))),
                    callback,
                    theme,
                    cx,
                    disabled || credential.masked.is_none(),
                    false,
                )),
        );
    }
    keys = keys.child(
        h_flex()
            .items_end()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .child(field_label(
                "Another environment variable",
                input_element(
                    inputs,
                    InputId::CustomCredentialEnv,
                    "Environment variable name",
                    "TOGETHER_API_KEY",
                    false,
                    disabled,
                    theme,
                ),
                theme,
            ))
            .child(settings_button(
                "credential-add-slot",
                "Add slot",
                Some(SettingsAction::Models(ModelsAction::AddCredentialSlot)),
                callback,
                theme,
                cx,
                disabled,
                false,
            )),
    );
    let private_row = settings_row(
        "private-routing",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Private routing", theme))
            .child(body_copy(
                "Requests no-training, zero-retention endpoints for the main agent loop on OpenRouter. If no eligible endpoint exists, the request fails. This does not cover secondary models, tools or account logging. Changes apply to newly started agent processes.",
                theme,
            ))
            .child(settings_checkbox(
                "private-routing-checkbox",
                "Require no-training, zero-retention OpenRouter endpoints",
                value.require_zero_retention,
                Some(SettingsAction::Models(ModelsAction::SetPrivateRouting(
                    value.require_zero_retention,
                ))),
                callback,
                theme,
                disabled,
            )),
        status_text("No model sent", false, theme),
    );
    let speech_row = settings_row(
        "models-speech",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Speech to text", theme))
            .child(body_copy(
                "Dictation runs against local OpenAI-compatible servers and is set up on its own page — the microphone grant, the speech server, and the S1-mini cleanup pass all live in Settings → Voice.",
                theme,
            )),
        status_text(
            if value.transcription_enabled { "On" } else { "Off" },
            value.transcription_enabled,
            theme,
        ),
    );
    let children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(catalog)
        .child(provider_section)
        .child(verifier)
        .child(advisor)
        .child(vision)
        .child(secret)
        .child(keys)
        .child(section("models-private", theme, private_row))
        .child(section("models-speech", theme, speech_row));
    page_frame(SettingsPageId::Models, state, theme, children)
}

#[allow(clippy::too_many_arguments)]
fn model_role_section(
    title: &'static str,
    copy: &'static str,
    label: &'static str,
    value: &VerifierPageState,
    rules_id: InputId,
    save_action: ModelsAction,
    callback: &Option<SettingsCallback>,
    inputs: &SettingsInputs,
    state: &SettingsState,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let mut body = v_flex()
        .id(format!("models-role-{}", label.to_ascii_lowercase()))
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            title,
            copy,
            if value.configured {
                "CONFIGURED"
            } else {
                "NOT SET UP"
            },
            theme,
        ))
        .child(
            v_flex()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .child(field_label(
                    format!("{} model", label),
                    input_element(
                        inputs,
                        InputId::ProviderModelId,
                        "Model ID",
                        "No model · choose one from the picker",
                        false,
                        disabled,
                        theme,
                    ),
                    theme,
                ))
                .child(field_label(
                    "What it is asked to do",
                    textarea_element(inputs, rules_id, "Model rules", disabled, px(160.), theme),
                    theme,
                ))
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(mono_label(
                            format!("{} characters", value.system_chars),
                            theme,
                        ))
                        .child(settings_button(
                            format!("models-save-{}", label.to_ascii_lowercase()),
                            format!("Save {}", label.to_ascii_lowercase()),
                            Some(SettingsAction::Models(save_action)),
                            callback,
                            theme,
                            cx,
                            disabled,
                            true,
                        )),
                ),
        );
    if !value.configured {
        body = body.child(
            div()
                .px(theme.spacing.s4)
                .pb(theme.spacing.s3)
                .text_color(theme.colors.danger)
                .text_size(theme.typography.fs_2xs)
                .child(format!(
                    "No {} model is set up.",
                    label.to_ascii_lowercase()
                )),
        );
    }
    body.into_any_element()
}

fn model_color(maker: &str, theme: &EmmaTheme) -> Hsla {
    match maker.to_ascii_lowercase().as_str() {
        "openai" => theme.colors.lime,
        "anthropic" => theme.colors.rose,
        "gemini" => theme.colors.blue,
        "local" => theme.colors.teal,
        _ => theme.colors.text_3,
    }
}

fn render_prompts(
    value: &PromptsPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let global = v_flex()
        .id("prompts-global")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Global prompt",
            "Added to every new agent process before the task starts.",
            format!("{} / 24576 characters", value.global_chars),
            theme,
        ))
        .child(
            v_flex()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .child(body_copy(
                    "The shared instruction that frames every turn. Keep it short enough to leave the model room for the thread and its tools.",
                    theme,
                ))
                .child(textarea_element(
                    inputs,
                    InputId::SystemPrompt,
                    "Global system prompt",
                    disabled,
                    px(280.),
                    theme,
                ))
                .child(prompt_variables("global", callback, theme, cx, disabled))
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(mono_label(
                            format!("{} / 24576 characters", value.global_chars),
                            theme,
                        ))
                        .child(
                            h_flex()
                                .gap(theme.spacing.s2)
                                .child(settings_button(
                                    "prompt-fork-global",
                                    "Fork",
                                    Some(SettingsAction::Prompts(PromptsAction::ForkGlobal)),
                                    callback,
                                    theme,
                                    cx,
                                    disabled,
                                    false,
                                ))
                                .child(settings_button(
                                    "prompt-reset-global",
                                    "Reset",
                                    Some(SettingsAction::Prompts(PromptsAction::ResetGlobal)),
                                    callback,
                                    theme,
                                    cx,
                                    disabled,
                                    false,
                                )),
                        ),
                ),
        );
    let mut presets = v_flex()
        .id("prompts-presets")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Conditional prompts",
            "Named prompt cards that apply to the model or model family you choose.",
            format!("{} / {}", value.presets.len(), value.maximum),
            theme,
        ));
    if value.presets.is_empty() {
        presets = presets.child(
            v_flex()
                .gap(theme.spacing.s2)
                .px(theme.spacing.s4)
                .py(theme.spacing.s4)
                .child(body_copy(
                    "No conditional prompts yet. Add one when a model needs a narrower instruction than the global prompt.",
                    theme,
                )),
        );
    }
    for (index, prompt) in value.presets.iter().enumerate() {
        let prompt_id = prompt.id.clone();
        let mut card =
            v_flex()
                .id(format!("prompt-card-{}", prompt.id))
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s4)
                .border_t_1()
                .border_color(theme.colors.border)
                .child(
                    h_flex()
                        .items_center()
                        .gap(theme.spacing.s3)
                        .child(settings_checkbox(
                            format!("prompt-enabled-{}", prompt.id),
                            "Use this prompt",
                            prompt.enabled,
                            Some(SettingsAction::Prompts(PromptsAction::TogglePreset(
                                prompt.id.clone(),
                                prompt.enabled,
                            ))),
                            callback,
                            theme,
                            disabled,
                        ))
                        .child(v_flex().flex_1().min_w_0().gap(theme.spacing.s1).child(
                            field_label(
                                "Name",
                                input_element(
                                    inputs,
                                    InputId::PromptName(index as u16),
                                    "Prompt name",
                                    prompt.name.clone(),
                                    false,
                                    disabled,
                                    theme,
                                ),
                                theme,
                            ),
                        ))
                        .child(mono_label(
                            if prompt.applies {
                                "APPLIES"
                            } else {
                                "NOT MATCHED"
                            },
                            theme,
                        )),
                )
                .child(field_label(
                    "Prompt body",
                    textarea_element(
                        inputs,
                        InputId::PromptBody(index as u16),
                        "Conditional prompt body",
                        disabled,
                        px(180.),
                        theme,
                    ),
                    theme,
                ))
                .child(prompt_scope(
                    &prompt_id,
                    &prompt.scope,
                    callback,
                    theme,
                    cx,
                    disabled,
                ))
                .child(prompt_variables(
                    prompt.id.clone(),
                    callback,
                    theme,
                    cx,
                    disabled,
                ))
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(mono_label(
                            format!("{} characters", prompt.body_chars),
                            theme,
                        ))
                        .child(
                            h_flex()
                                .gap(theme.spacing.s2)
                                .child(settings_button(
                                    format!("prompt-fork-{}", prompt.id),
                                    "Fork",
                                    Some(SettingsAction::Prompts(PromptsAction::ForkPreset(
                                        prompt.id.clone(),
                                    ))),
                                    callback,
                                    theme,
                                    cx,
                                    disabled,
                                    false,
                                ))
                                .child(settings_button(
                                    format!("prompt-delete-{}", prompt.id),
                                    "Delete",
                                    Some(SettingsAction::Prompts(PromptsAction::DeletePreset(
                                        prompt.id.clone(),
                                    ))),
                                    callback,
                                    theme,
                                    cx,
                                    disabled,
                                    false,
                                )),
                        ),
                );
        if index == value.presets.len() - 1 {
            card = card.border_b_1().border_color(theme.colors.border);
        }
        presets = presets.child(card);
    }
    presets = presets.child(
        h_flex()
            .justify_between()
            .items_center()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .child(body_copy(
                "Prompt names are local to this workspace and never become model instructions on their own.",
                theme,
            ))
            .child(settings_button(
                "prompt-add",
                "Add conditional prompt",
                Some(SettingsAction::Prompts(PromptsAction::AddPreset)),
                callback,
                theme,
                cx,
                disabled || value.presets.len() >= value.maximum,
                true,
            )),
    );
    page_frame(
        SettingsPageId::Prompts,
        state,
        theme,
        v_flex()
            .w_full()
            .gap(theme.spacing.s5)
            .child(global)
            .child(presets)
            .child(body_copy(
                "Variables are expanded at send time: they describe the current model, workspace, operating system, date, and available tools.",
                theme,
            )),
    )
}

fn prompt_variables(
    target: impl Into<SharedString>,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let target = target.into();
    let values = [
        "{available_tools}",
        "{model}",
        "{model_family}",
        "{workspace}",
        "{os}",
        "{date}",
        "{mode}",
    ];
    let mut row = h_flex()
        .id(format!("prompt-variables-{}", target))
        .flex_wrap()
        .gap(theme.spacing.s2);
    for (index, value) in values.into_iter().enumerate() {
        row = row.child(
            settings_button(
                format!("prompt-variable-{}-{}", target, index),
                value,
                Some(SettingsAction::Prompts(PromptsAction::InsertVariable(
                    target.clone(),
                    value.into(),
                ))),
                callback,
                theme,
                cx,
                disabled,
                false,
            )
            .font_family(theme.typography.font_code.clone())
            .text_size(theme.typography.fs_2xs),
        );
    }
    row.into_any_element()
}

fn prompt_scope(
    id: &SharedString,
    selected: &SharedString,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let scopes = [
        ("all", "Every model"),
        ("model", "One model"),
        ("family", "One family"),
    ];
    let mut row = h_flex()
        .id(format!("prompt-scope-{}", id))
        .flex_wrap()
        .gap(theme.spacing.s2)
        .child(mono_label("Applies to", theme));
    for (scope_id, label) in scopes {
        row = row.child(settings_button(
            format!("prompt-scope-{}-{}", id, scope_id),
            label,
            Some(SettingsAction::Prompts(PromptsAction::SetPresetScope(
                id.clone(),
                scope_id.into(),
            ))),
            callback,
            theme,
            cx,
            disabled,
            selected.as_ref() == scope_id,
        ));
    }
    row.into_any_element()
}

fn render_tools(
    value: &ToolsPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let mut groups: Vec<SharedString> = Vec::new();
    for tool in &value.tools {
        if !groups.iter().any(|group| group == &tool.group) {
            groups.push(tool.group.clone());
        }
    }
    let mode = settings_row(
        "tools-default-mode",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Default permission mode", theme))
            .child(body_copy(
                "The rung a thread's picker opens on. A thread keeps its own choice after the first turn; Quick Ask keeps separate memory.",
                theme,
            )),
        choice_group(
            "tools-mode",
            &PermissionMode::ALL,
            value.default_mode,
            |mode| mode.label(),
            |mode| SettingsAction::Tools(ToolsAction::SetDefaultMode(mode)),
            callback,
            theme,
            cx,
            disabled,
        ),
    );
    let mut built_in = v_flex()
        .id("tools-built-in")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "What the agent may call",
            "Switching a tool off hides it from the model entirely. Plan still hides every action that changes anything.",
            if value.tools.iter().all(|tool| tool.enabled) {
                SharedString::from("ALL ON")
            } else {
                SharedString::from(format!(
                    "{} off",
                    value.tools.iter().filter(|tool| !tool.enabled).count()
                ))
            },
            theme,
        ));
    for group in groups {
        let mut group_view = v_flex()
            .id(format!("tool-group-{}", group))
            .gap(theme.spacing.s2)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .border_t_1()
            .border_color(theme.colors.border);
        group_view = group_view.child(mono_label(group.clone(), theme));
        for tool in value.tools.iter().filter(|tool| tool.group == group) {
            group_view = group_view.child(settings_checkbox(
                format!("tool-{}", tool.id),
                tool.label.clone(),
                tool.enabled,
                Some(SettingsAction::Tools(ToolsAction::ToggleTool(
                    tool.id.clone(),
                    tool.enabled,
                ))),
                callback,
                theme,
                disabled,
            ));
            group_view = group_view.child(
                div()
                    .ml(px(28.))
                    .mt(px(-4.))
                    .text_color(theme.colors.text_2)
                    .text_size(theme.typography.fs_sm)
                    .child(tool.blurb.clone()),
            );
        }
        built_in = built_in.child(group_view);
    }
    let search = search_provider_section(value, state, inputs, callback, theme, cx);
    let written = tool_target_section(
        "tools-written",
        "Written by Emma",
        "Her own tools",
        "Every tool Emma wrote for herself with write_tool appears here when it saves. Turning one off leaves the script on disk but hides it from run_tool.",
        &value.written,
        "Emma has not written any tools yet.",
        0,
        callback,
        theme,
        disabled,
    );
    let skills = tool_target_section(
        "tools-skills",
        "Imported",
        "Skills",
        "A skill that is off never reaches the model and cannot be attached to a thread. Import more in Settings → Imports & plugins.",
        &value.skills,
        "No skills imported yet.",
        1,
        callback,
        theme,
        disabled,
    );
    let servers = tool_target_section(
        "tools-servers",
        "Imported",
        "MCP servers",
        "A server that is off is not handed to the harness, so it never starts and its tools are never offered.",
        &value.servers,
        "No MCP servers imported yet.",
        2,
        callback,
        theme,
        disabled,
    );
    page_frame(
        SettingsPageId::Tools,
        state,
        theme,
        v_flex()
            .w_full()
            .gap(theme.spacing.s5)
            .child(section("tools-mode-section", theme, mode))
            .child(built_in)
            .child(search)
            .child(written)
            .child(skills)
            .child(servers),
    )
}

fn search_provider_section(
    value: &ToolsPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let mut body = v_flex()
        .id("tools-web-search-body")
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3);
    if value.search.is_empty() {
        body = body.child(body_copy(
            "No web search provider is configured. Add a keyless local endpoint or a provider key and put it first when you want the web_search tool exposed.",
            theme,
        ));
    }
    for (index, provider) in value.search.iter().enumerate() {
        let row = h_flex()
            .id(format!("search-provider-{}", provider.id))
            .items_start()
            .gap(theme.spacing.s3)
            .py(theme.spacing.s2)
            .border_t_1()
            .border_color(theme.colors.border)
            .child(
                v_flex()
                    .w(px(28.))
                    .gap(theme.spacing.s1)
                    .child(settings_button(
                        format!("search-up-{}", provider.id),
                        "↑",
                        Some(SettingsAction::Tools(ToolsAction::SearchProviderUp(index))),
                        callback,
                        theme,
                        cx,
                        disabled || index == 0,
                        false,
                    ))
                    .child(settings_button(
                        format!("search-down-{}", provider.id),
                        "↓",
                        Some(SettingsAction::Tools(ToolsAction::SearchProviderDown(
                            index,
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled || index + 1 == value.search.len(),
                        false,
                    )),
            )
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(theme.spacing.s1)
                    .child(mono_heading(provider.label.clone(), theme))
                    .child(body_copy(provider.detail.clone(), theme)),
            )
            .child(
                v_flex()
                    .w(px(300.))
                    .gap(theme.spacing.s2)
                    .child(field_label(
                        "Endpoint",
                        input_element(
                            inputs,
                            InputId::SearchEndpoint(index as u16),
                            "Search endpoint",
                            provider.endpoint.clone(),
                            false,
                            disabled,
                            theme,
                        ),
                        theme,
                    ))
                    .child(field_label(
                        "Key environment variable",
                        input_element(
                            inputs,
                            InputId::SearchCredential(index as u16),
                            "Search credential environment variable",
                            provider.credential_env.clone(),
                            true,
                            disabled || provider.keyless,
                            theme,
                        ),
                        theme,
                    )),
            )
            .child(settings_button(
                format!("search-remove-{}", provider.id),
                "Remove",
                Some(SettingsAction::Tools(ToolsAction::RemoveSearchProvider(
                    provider.id.clone(),
                ))),
                callback,
                theme,
                cx,
                disabled,
                false,
            ));
        body = body.child(row);
    }
    body = body.child(
        h_flex()
            .gap(theme.spacing.s2)
            .items_center()
            .child(settings_button(
                "search-add",
                "Add provider",
                Some(SettingsAction::Tools(ToolsAction::AddSearchProvider)),
                callback,
                theme,
                cx,
                disabled,
                false,
            ))
            .child(settings_button(
                "search-save",
                "Save ranking",
                Some(SettingsAction::Tools(ToolsAction::SaveSearchRanking)),
                callback,
                theme,
                cx,
                disabled,
                true,
            )),
    );
    section(
        "tools-web-search",
        theme,
        v_flex()
            .child(settings_section_header(
                "Built in",
                "Web search",
                if value.search.is_empty() {
                    "OFF"
                } else {
                    "ORDERED"
                },
                theme,
            ))
            .child(body),
    )
}

#[allow(clippy::too_many_arguments)]
fn tool_target_section(
    id: &'static str,
    kicker: &'static str,
    title: &'static str,
    copy: &'static str,
    targets: &[ToolTargetState],
    empty: &'static str,
    kind: u8,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    disabled: bool,
) -> AnyElement {
    let mut body = v_flex()
        .id(format!("{}-body", id))
        .gap(theme.spacing.s2)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .child(body_copy(copy, theme));
    if targets.is_empty() {
        body = body.child(body_copy(empty, theme));
    }
    for target in targets {
        let action = match kind {
            0 => SettingsAction::Tools(ToolsAction::ToggleTool(target.id.clone(), target.enabled)),
            1 => SettingsAction::Tools(ToolsAction::ToggleSkill(target.id.clone(), target.enabled)),
            _ => {
                SettingsAction::Tools(ToolsAction::ToggleServer(target.id.clone(), target.enabled))
            }
        };
        body = body.child(
            h_flex()
                .id(format!("{}-row-{}", id, target.id))
                .items_start()
                .gap(theme.spacing.s2)
                .child(settings_checkbox(
                    format!("{}-{}", id, target.id),
                    target.name.clone(),
                    target.enabled,
                    Some(action),
                    callback,
                    theme,
                    disabled,
                ))
                .child(body_copy(target.source.clone(), theme)),
        );
    }
    section(
        id,
        theme,
        v_flex()
            .child(settings_section_header(
                kicker,
                title,
                if targets.is_empty() {
                    SharedString::from("NONE")
                } else {
                    SharedString::from(targets.len().to_string())
                },
                theme,
            ))
            .child(body),
    )
}

fn render_permissions(
    value: &PermissionsPageState,
    state: &SettingsState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let required = value
        .grants
        .iter()
        .filter(|grant| !grant.id.unavailable(state.platform))
        .count();
    let granted = value
        .grants
        .iter()
        .filter(|grant| !grant.id.unavailable(state.platform) && grant.status == Some(true))
        .count();
    let mut list = v_flex()
        .id("permissions-list")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(
            h_flex()
                .items_baseline()
                .justify_between()
                .gap(theme.spacing.s4)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(
                    v_flex()
                        .flex_1()
                        .min_w_0()
                        .gap(theme.spacing.s2)
                        .child(mono_heading("What this computer lets Emma do", theme))
                        .child(body_copy(
                            "Every grant belongs to the operating system, not to Emma: she can only send you to the setting that flips it. Nothing is asked for until a task needs it, and a refused grant stops that task rather than the app.",
                            theme,
                        )),
                )
                .child(mono_label(format!("{} of {}", granted, required), theme)),
        );
    if value.grants.is_empty() {
        list = list.child(body_copy(
            "Permission status is still loading. Refresh after granting a capability.",
            theme,
        ));
    }
    for grant in &value.grants {
        let unavailable = grant.id.unavailable(state.platform);
        let status = if unavailable {
            SetupMarkState::Unknown
        } else {
            match grant.status {
                Some(true) => SetupMarkState::On,
                Some(false) => SetupMarkState::Off,
                None => SetupMarkState::Unknown,
            }
        };
        let mut description = v_flex()
            .flex_1()
            .min_w_0()
            .gap(theme.spacing.s2)
            .child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(mark(status, theme))
                    .child(mono_heading(
                        permission_title(grant.id, state.platform),
                        theme,
                    )),
            )
            .child(body_copy(grant.what.clone(), theme));
        if !grant.tasks.is_empty() {
            let mut tasks = v_flex().gap(theme.spacing.s1);
            for task in &grant.tasks {
                tasks = tasks.child(
                    h_flex()
                        .gap(theme.spacing.s2)
                        .ml(px(20.))
                        .text_color(theme.colors.text_2)
                        .text_size(theme.typography.fs_sm)
                        .child("·")
                        .child(task.clone()),
                );
            }
            description = description.child(tasks);
        }
        if grant.relaunch && !unavailable && grant.status != Some(true) {
            description =
                description.child(mono_label("Relaunch Emma once you have granted it.", theme));
        }
        list = list.child(
            h_flex()
                .id(format!("permission-row-{}", grant.id.id()))
                .items_start()
                .gap(theme.spacing.s4)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(description)
                .child(settings_button(
                    format!("permission-open-{}", grant.id.id()),
                    if unavailable {
                        "Not required"
                    } else if grant.status == Some(true) {
                        "Review ↗"
                    } else {
                        "Grant ↗"
                    },
                    Some(SettingsAction::Permissions(
                        PermissionsAction::OpenCapability(grant.id),
                    )),
                    callback,
                    theme,
                    cx,
                    disabled || unavailable,
                    false,
                )),
        );
    }
    let tools = settings_row(
        "permissions-tools",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("What the agent may call", theme))
            .child(body_copy(
                "Tools, skills, and MCP servers each have their own switch, and the mode picker decides which calls ask you first.",
                theme,
            )),
        settings_button(
            "permissions-open-tools",
            "Open Tools",
            Some(SettingsAction::Permissions(PermissionsAction::OpenTools)),
            callback,
            theme,
            cx,
            disabled,
            false,
        ),
    );
    page_frame(
        SettingsPageId::Permissions,
        state,
        theme,
        v_flex()
            .w_full()
            .gap(theme.spacing.s5)
            .child(list)
            .child(section("permissions-tools-section", theme, tools))
            .child(settings_button(
                "permissions-refresh",
                "Refresh grants",
                Some(SettingsAction::Permissions(PermissionsAction::Refresh)),
                callback,
                theme,
                cx,
                disabled,
                false,
            )),
    )
}

fn permission_title(id: SetupPermissionId, platform: Platform) -> SharedString {
    match (id, platform) {
        (SetupPermissionId::Screen, Platform::Windows) => "Screen capture".into(),
        (SetupPermissionId::Files, Platform::Windows) => "Files".into(),
        (SetupPermissionId::Accessibility, Platform::Windows) => "App control".into(),
        _ => id.title().into(),
    }
}

fn render_harness(
    value: &HarnessPageState,
    state: &SettingsState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let reinject_on = value.reinject_steps > 0 || value.reinject_percent > 0;
    let prune_on = value.prune_steps > 0 || value.prune_percent > 0;
    let compact_on = value.auto_compact_percent > 0;
    let mut hooks = v_flex()
        .id("harness-context-hooks")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Experimental",
            "Context window hooks",
            if reinject_on || prune_on || compact_on {
                "ON"
            } else {
                "OFF"
            },
            theme,
        ))
        .child(body_copy(
            "The first two levers rewrite only the copy sent for one model step. Auto compact advances the durable context boundary once between user turns. Routes without a known context window leave percentage triggers inert.",
            theme,
        ));
    hooks = hooks.child(harness_experiment(
        "harness-reinject",
        "Repeat the original prompt",
        "Appends what you asked for, unchanged, after the newest tool results so a long run does not bury the request under its own output.",
        reinject_on,
        value.reinject_steps,
        value.reinject_percent,
        15,
        true,
        callback,
        theme,
        cx,
        disabled,
    ));
    hooks = hooks.child(harness_experiment(
        "harness-prune",
        "Prune older tool results",
        "Replaces earlier tool output with a one-line placeholder, keeping the newest batch intact so the model is not made to rerun the call it just made.",
        prune_on,
        value.prune_steps,
        value.prune_percent,
        15,
        false,
        callback,
        theme,
        cx,
        disabled,
    ));
    hooks = hooks.child(
        v_flex()
            .id("harness-auto-compact")
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .border_t_1()
            .border_color(theme.colors.border)
            .child(
                h_flex()
                    .items_center()
                    .justify_between()
                    .child(settings_switch(
                        "harness-auto-compact-switch",
                        "Auto compact",
                        compact_on,
                        Some(SettingsAction::Harness(HarnessAction::ToggleAutoCompact(
                            compact_on,
                        ))),
                        callback,
                        theme,
                        disabled,
                    ))
                    .child(mono_label(
                        "Runs /compact once between turns when history reaches the mark.",
                        theme,
                    )),
            )
            .child(harness_percent_stepper(
                "harness-auto-compact-percent",
                value.auto_compact_percent,
                |next| SettingsAction::Harness(HarnessAction::SetAutoCompactPercent(next)),
                callback,
                theme,
                cx,
                disabled,
            )),
    );
    page_frame(
        SettingsPageId::Harness,
        state,
        theme,
        v_flex().w_full().gap(theme.spacing.s5).child(hooks),
    )
}

#[allow(clippy::too_many_arguments)]
fn harness_experiment(
    id: &'static str,
    label: &'static str,
    copy: &'static str,
    enabled: bool,
    steps: u16,
    percent: u8,
    suggested: u16,
    reinject: bool,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let toggle = if reinject {
        SettingsAction::Harness(HarnessAction::ToggleReinject(enabled))
    } else {
        SettingsAction::Harness(HarnessAction::TogglePrune(enabled))
    };
    let mut row = v_flex()
        .id(id)
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_t_1()
        .border_color(theme.colors.border)
        .child(
            h_flex()
                .items_center()
                .justify_between()
                .child(settings_switch(
                    format!("{}-switch", id),
                    label,
                    enabled,
                    Some(toggle),
                    callback,
                    theme,
                    disabled,
                ))
                .child(body_copy(copy, theme)),
        );
    row = row.child(
        h_flex()
            .gap(theme.spacing.s3)
            .items_center()
            .child(mono_label("Every N steps", theme))
            .child(harness_steps_stepper(
                format!("{}-steps", id),
                steps,
                suggested,
                reinject,
                callback,
                theme,
                cx,
                disabled,
            ))
            .child(mono_label("At % of context", theme))
            .child(harness_percent_stepper(
                format!("{}-percent", id),
                percent,
                if reinject {
                    (|next| SettingsAction::Harness(HarnessAction::SetReinjectPercent(next)))
                        as fn(u8) -> SettingsAction
                } else {
                    (|next| SettingsAction::Harness(HarnessAction::SetPrunePercent(next)))
                        as fn(u8) -> SettingsAction
                },
                callback,
                theme,
                cx,
                disabled,
            ))
            .child(mono_label(
                if enabled {
                    "Set either trigger; 0 turns it off."
                } else {
                    "Off. Nothing is changed in the context window."
                },
                theme,
            )),
    );
    row.into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn harness_steps_stepper(
    id: impl Into<SharedString>,
    value: u16,
    suggested: u16,
    reinject: bool,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let id = id.into();
    let id_label = id.clone();
    let value = value.min(1000);
    let down = value.saturating_sub(1);
    let up = value.saturating_add(1).min(1000);
    let action = |next| {
        if reinject {
            SettingsAction::Harness(HarnessAction::SetReinjectSteps(next))
        } else {
            SettingsAction::Harness(HarnessAction::SetPruneSteps(next))
        }
    };
    h_flex()
        .id(id)
        .items_center()
        .gap(theme.spacing.s1)
        .child(settings_button(
            format!("{}-down", id_label),
            "−",
            Some(action(down)),
            callback,
            theme,
            cx,
            disabled || value == 0,
            false,
        ))
        .child(
            div()
                .min_w(px(42.))
                .px(theme.spacing.s2)
                .text_color(theme.colors.text)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_sm)
                .child(value.to_string()),
        )
        .child(settings_button(
            format!("{}-up", id_label),
            "+",
            Some(action(if value == 0 { suggested } else { up })),
            callback,
            theme,
            cx,
            disabled || value >= 1000,
            false,
        ))
        .into_any_element()
}

fn harness_percent_stepper(
    id: impl Into<SharedString>,
    value: u8,
    action: impl Fn(u8) -> SettingsAction,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let id = id.into();
    let id_label = id.clone();
    let value = value.min(100);
    h_flex()
        .id(id)
        .items_center()
        .gap(theme.spacing.s1)
        .child(settings_button(
            format!("{}-down", id_label),
            "−",
            Some(action(value.saturating_sub(5))),
            callback,
            theme,
            cx,
            disabled || value == 0,
            false,
        ))
        .child(
            div()
                .min_w(px(42.))
                .px(theme.spacing.s2)
                .text_color(theme.colors.text)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_sm)
                .child(format!("{}%", value)),
        )
        .child(settings_button(
            format!("{}-up", id_label),
            "+",
            Some(action(value.saturating_add(5).min(100))),
            callback,
            theme,
            cx,
            disabled || value >= 100,
            false,
        ))
        .into_any_element()
}

fn render_imports(
    value: &ImportsPageState,
    state: &SettingsState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let selected = value
        .sources
        .iter()
        .filter(|source| source.selected)
        .count();
    let mut sources = v_flex()
        .id("imports-sources")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "First launch / optional",
            "Bring your agent setup",
            format!("{} selected", selected),
            theme,
        ))
        .child(body_copy(
            "Emma can find Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf, and Devin defaults on this computer. References are imported as links, not copied into a second hidden store.",
            theme,
        ));
    if value.sources.is_empty() {
        sources = sources.child(body_copy(
            "Scan for agent defaults to see what can be imported.",
            theme,
        ));
    }
    for source in &value.sources {
        let mut locations = v_flex().gap(theme.spacing.s1);
        for location in &source.locations {
            locations = locations.child(mono_label(location.clone(), theme));
        }
        let mut row = h_flex()
            .id(format!("import-source-{}", source.id))
            .items_start()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .border_t_1()
            .border_color(theme.colors.border)
            .child(settings_checkbox(
                format!("import-toggle-{}", source.id),
                source.label.clone(),
                source.selected,
                Some(SettingsAction::Imports(ImportsAction::ToggleSource(
                    source.id.clone(),
                    source.selected,
                ))),
                callback,
                theme,
                disabled || !source.available,
            ))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(theme.spacing.s2)
                    .child(
                        h_flex()
                            .gap(theme.spacing.s3)
                            .child(mono_label(format!("{} skills", source.skills), theme))
                            .child(mono_label(format!("{} MCP", source.mcp_configs), theme)),
                    )
                    .child(locations),
            )
            .child(mono_label(
                if source.available {
                    "FOUND"
                } else {
                    "NOT FOUND"
                },
                theme,
            ));
        if !source.available {
            row = row.opacity(0.6);
        }
        sources = sources.child(row);
    }
    let status = if matches!(value.scan_status, SettingsAsyncState::Loading) {
        "Scanning…"
    } else {
        "Scan again"
    };
    let actions = h_flex()
        .items_center()
        .justify_between()
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_t_1()
        .border_color(theme.colors.border)
        .child(mono_label(
            if matches!(value.import_status, SettingsAsyncState::Ready) {
                "Imported references are ready."
            } else {
                "References, not copies."
            },
            theme,
        ))
        .child(
            h_flex()
                .gap(theme.spacing.s2)
                .child(settings_button(
                    "imports-scan",
                    status,
                    Some(SettingsAction::Imports(ImportsAction::Scan)),
                    callback,
                    theme,
                    cx,
                    disabled || matches!(value.scan_status, SettingsAsyncState::Loading),
                    false,
                ))
                .child(settings_button(
                    "imports-selected",
                    "Import selected",
                    Some(SettingsAction::Imports(ImportsAction::ImportSelected)),
                    callback,
                    theme,
                    cx,
                    disabled || selected == 0,
                    true,
                )),
        );
    sources = sources.child(actions);
    page_frame(
        SettingsPageId::Imports,
        state,
        theme,
        v_flex()
            .w_full()
            .gap(theme.spacing.s5)
            .child(sources)
            .child(async_status_line_block(
                "imports-status",
                &value.import_status,
                theme,
            )),
    )
}

fn async_status_line_block(
    id: &'static str,
    status: &SettingsAsyncState,
    theme: &EmmaTheme,
) -> AnyElement {
    match status {
        SettingsAsyncState::Idle | SettingsAsyncState::Ready => div().id(id).into_any_element(),
        _ => v_flex()
            .id(id)
            .gap(theme.spacing.s2)
            .child(mono_label(async_status_line(status), theme))
            .into_any_element(),
    }
}

fn render_mobile(
    value: &MobilePageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let pairing = v_flex()
        .id("mobile-pairing")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Pair a phone with Emma",
            "Use the phone as a remote control for the task already in this workspace.",
            if value.listening { "LISTENING" } else { "OFFLINE" },
            theme,
        ))
        .child(
            v_flex()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .child(body_copy(
                    "A local pairing code links one phone to this computer. The PIN is used only to authenticate the pairing and is never shown after the link is made.",
                    theme,
                ))
                .child(field_label(
                    "Pairing PIN",
                    input_element(
                        inputs,
                        InputId::MobilePin,
                        "Pairing PIN",
                        "Six digits",
                        true,
                        disabled || value.pairing,
                        theme,
                    ),
                    theme,
                ))
                .child(
                    h_flex()
                        .items_center()
                        .gap(theme.spacing.s3)
                        .child(settings_button(
                            "mobile-pair",
                            if value.pairing { "Waiting for phone…" } else { "Pair phone" },
                            Some(SettingsAction::Mobile(MobileAction::Pair)),
                            callback,
                            theme,
                            cx,
                            disabled || value.pairing || !value.pin_ready,
                            true,
                        ))
                        .child(if value.pin_ready {
                            status_text("PIN ready", true, theme)
                        } else {
                            status_text("Enter a PIN", false, theme)
                        }),
                ),
        );
    let mut devices = v_flex()
        .id("mobile-devices")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong)
        .child(settings_section_header(
            "Paired devices",
            "A device can steer the active workspace while it remains connected.",
            format!("{} linked", value.devices.len()),
            theme,
        ));
    if value.devices.is_empty() {
        devices = devices.child(body_copy(
            "No phones are paired yet. Start a pairing above.",
            theme,
        ));
    }
    for device in &value.devices {
        devices = devices.child(
            h_flex()
                .id(format!("mobile-device-{}", device.id))
                .items_center()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s3)
                .border_t_1()
                .border_color(theme.colors.border)
                .child(status_text(
                    if device.connected {
                        "Connected"
                    } else {
                        "Offline"
                    },
                    device.connected,
                    theme,
                ))
                .child(
                    v_flex()
                        .flex_1()
                        .gap(theme.spacing.s1)
                        .child(mono_heading(format!("Phone {}", device.id), theme))
                        .child(mono_label(format!("Last seen {}", device.last_seen), theme)),
                )
                .child(settings_button(
                    format!("mobile-unpair-{}", device.id),
                    "Unpair",
                    Some(SettingsAction::Mobile(MobileAction::Unpair(device.id))),
                    callback,
                    theme,
                    cx,
                    disabled,
                    false,
                )),
        );
    }
    let mut children = v_flex()
        .w_full()
        .gap(theme.spacing.s5)
        .child(pairing)
        .child(devices);
    if let Some(code) = value.pairing_code.clone() {
        children = children.child(section(
            "mobile-pairing-code",
            theme,
            v_flex()
                .gap(theme.spacing.s2)
                .px(theme.spacing.s4)
                .py(theme.spacing.s4)
                .child(mono_heading("Pairing code", theme))
                .child(
                    div()
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_3xl)
                        .text_color(theme.colors.accent)
                        .child(code),
                )
                .child(mono_label(
                    value
                        .expires_in
                        .map(|seconds| format!("Expires in {} seconds", seconds))
                        .unwrap_or_else(|| "Waiting for a phone".into()),
                    theme,
                ))
                .child(settings_button(
                    "mobile-cancel-pair",
                    "Cancel",
                    Some(SettingsAction::Mobile(MobileAction::CancelPair)),
                    callback,
                    theme,
                    cx,
                    disabled,
                    false,
                )),
        ));
    }
    if let Some(address) = value.address.clone() {
        children = children.child(body_copy(
            format!(
                "Connect on the same network at {}. {}",
                address,
                if value.full {
                    "Full remote controls are enabled."
                } else {
                    "Remote controls are limited until pairing completes."
                }
            ),
            theme,
        ));
    }
    page_frame(SettingsPageId::Mobile, state, theme, children)
}

fn render_built(
    value: &BuiltPageState,
    state: &SettingsState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let mut cards = v_flex()
        .id("built-cards")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong);
    if value.cards.is_empty() {
        cards = cards.child(
            v_flex()
                .gap(theme.spacing.s2)
                .px(theme.spacing.s4)
                .py(theme.spacing.s4)
                .child(mono_heading("Nothing built yet", theme))
                .child(body_copy(
                    "When Emma writes a reusable component for her own interface, it appears here. Attach one to a thread to work on it again.",
                    theme,
                )),
        );
    }
    for (index, card) in value.cards.iter().enumerate() {
        let mut body = v_flex()
            .id(format!("built-card-{}", card.id))
            .gap(theme.spacing.s3)
            .px(theme.spacing.s4)
            .py(theme.spacing.s4)
            .border_b_1()
            .border_color(theme.colors.border)
            .when(card.disabled, |this| this.opacity(0.6))
            .child(
                h_flex()
                    .items_center()
                    .gap(theme.spacing.s3)
                    .child(
                        div()
                            .w(px(30.))
                            .h(px(30.))
                            .items_center()
                            .justify_center()
                            .bg(theme.colors.surface_3)
                            .text_color(theme.colors.lime)
                            .font_family(theme.typography.font_mono.clone())
                            .child("✦"),
                    )
                    .child(
                        v_flex()
                            .flex_1()
                            .min_w_0()
                            .gap(theme.spacing.s1)
                            .child(mono_heading(card.title.clone(), theme))
                            .child(mono_label(
                                format!("v{} · built by Emma", card.version),
                                theme,
                            )),
                    )
                    .child(status_text(
                        if card.disabled { "Hidden" } else { "Enabled" },
                        !card.disabled,
                        theme,
                    ))
                    .child(settings_button(
                        format!("built-attach-{}", card.id),
                        "Attach",
                        Some(SettingsAction::Built(BuiltAction::Attach(card.id.clone()))),
                        callback,
                        theme,
                        cx,
                        disabled,
                        true,
                    ))
                    .child(settings_button(
                        format!("built-toggle-{}", card.id),
                        if card.disabled { "Enable" } else { "Hide" },
                        Some(SettingsAction::Built(BuiltAction::ToggleEnabled(
                            card.id.clone(),
                            !card.disabled,
                        ))),
                        callback,
                        theme,
                        cx,
                        disabled,
                        false,
                    ))
                    .child(settings_button(
                        format!("built-delete-{}", card.id),
                        "Delete…",
                        Some(SettingsAction::Built(BuiltAction::Delete(card.id.clone()))),
                        callback,
                        theme,
                        cx,
                        disabled,
                        false,
                    )),
            );
        if card.expands {
            body = body.child(
                v_flex()
                    .gap(theme.spacing.s2)
                    .child(body_copy(
                        "This component keeps its source and version locally. Expand it from the thread when you need to inspect or edit it.",
                        theme,
                    ))
                    .child(
                        h_flex()
                            .gap(theme.spacing.s2)
                            .child(settings_button(
                                format!("built-expand-{}", card.id),
                                "Open details",
                                Some(SettingsAction::Built(BuiltAction::ToggleExpanded(
                                    card.id.clone(),
                                    true,
                                ))),
                                callback,
                                theme,
                                cx,
                                disabled,
                                false,
                            )),
                    ),
            );
        }
        if !card.variables.is_empty() {
            let mut variables = v_flex()
                .gap(theme.spacing.s2)
                .child(mono_label("Variables", theme));
            for (variable_index, variable) in card.variables.iter().enumerate() {
                variables = variables.child(
                    h_flex()
                        .id(format!("built-variable-{}-{}", index, variable_index))
                        .items_end()
                        .gap(theme.spacing.s2)
                        .child(field_label(
                            variable.clone(),
                            input_element(
                                inputs,
                                InputId::BuiltVariable(index as u16, variable_index as u16),
                                "Built component variable",
                                "Leave empty to clear",
                                true,
                                disabled,
                                theme,
                            ),
                            theme,
                        ))
                        .child(settings_button(
                            format!("built-variable-save-{}-{}", index, variable_index),
                            "Save",
                            Some(SettingsAction::Built(BuiltAction::SaveVariable(
                                variable.clone(),
                            ))),
                            callback,
                            theme,
                            cx,
                            disabled,
                            false,
                        ))
                        .child(settings_button(
                            format!("built-variable-clear-{}-{}", index, variable_index),
                            "Clear",
                            Some(SettingsAction::Built(BuiltAction::ClearVariable(
                                variable.clone(),
                            ))),
                            callback,
                            theme,
                            cx,
                            disabled,
                            false,
                        )),
                );
            }
            body = body.child(variables);
        }
        cards = cards.child(body);
    }
    cards = cards.child(
        h_flex()
            .justify_end()
            .px(theme.spacing.s4)
            .py(theme.spacing.s3)
            .border_t_1()
            .border_color(theme.colors.border)
            .child(settings_button(
                "built-delete-all",
                "Delete all built pieces…",
                Some(SettingsAction::Built(BuiltAction::DeleteAll)),
                callback,
                theme,
                cx,
                disabled || value.cards.is_empty(),
                false,
            )),
    );
    page_frame(
        SettingsPageId::Built,
        state,
        theme,
        v_flex().w_full().gap(theme.spacing.s5).child(cards),
    )
}

fn render_privacy(
    value: &PrivacyPageState,
    state: &SettingsState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let reset_action = if value.reset_confirmation {
        SettingsAction::Privacy(PrivacyAction::ConfirmReset)
    } else {
        SettingsAction::Privacy(PrivacyAction::BeginReset)
    };
    let reset_label = if value.reset_confirmation {
        "Confirm reset"
    } else {
        "Reset Emma"
    };
    let reset_row = settings_row(
        "privacy-reset",
        theme,
        v_flex()
            .gap(theme.spacing.s2)
            .child(mono_heading("Start fresh", theme))
            .child(body_copy(
                "Threads, artifacts, plans, connected folders, saved keys, and every setting go. Notes in your vault stay where they are because they are your files. This cannot be undone.",
                theme,
            )),
        settings_button(
            "privacy-reset-button",
            reset_label,
            Some(reset_action),
            callback,
            theme,
            cx,
            disabled,
            false,
        )
        .text_color(theme.colors.danger)
        .border_color(theme.colors.danger),
    );
    let mut reset = v_flex().id("privacy-reset-body").w_full().child(reset_row);
    if value.reset_confirmation {
        reset = reset.child(body_copy(
            "This is the final confirmation. Emma will clear local data and restart empty.",
            theme,
        ));
        reset = reset.child(settings_button(
            "privacy-reset-cancel",
            "Cancel",
            Some(SettingsAction::Privacy(PrivacyAction::CancelReset)),
            callback,
            theme,
            cx,
            disabled,
            false,
        ));
    }
    let prose = [
        (
            "OpenRouter account settings are separate",
            "Private input/output logging and using prompts to improve OpenRouter are separate opt-ins. A free or paid model is not a privacy guarantee. Private routing does not change your account settings.",
            "Review your provider’s current data policy and your account settings before sending private material.",
        ),
        (
            "Zero-retention routing is opt-in",
            "The flag covers the main agent loop at an openrouter.ai endpoint. Verifier, vision, advisor, secrets and note-tagger calls do not carry it. It also does not cover tools, widgets, browsers or external CLIs.",
            "Private routing in Settings → Models requests no-training, zero-retention endpoints for OpenRouter agent turns. It is not an app-wide offline switch.",
        ),
        (
            "Threads and notes are stored locally",
            "Thread records live in the Emma data directory, moved by EMMA_DATA_DIR. Notes are written into your chosen vault. Relevant thread history and tool results reach the selected model.",
            "Emma stores durable Markdown through the Rust host. Pane layout and an unsent overlay draft stay in local application storage.",
        ),
        (
            "Audio is transcribed locally",
            "A non-local speech or cleanup endpoint is refused when you save it and again before every use. The utterance goes to a temporary file, is read once, and is deleted.",
            "Transcription and cleanup use loopback servers or on-device speech. Dictated words reach the selected thread model when you send them.",
        ),
        (
            "Computer use shares approved app text",
            "App titles, labels and values may reach your turn’s model after you approve the app. Computer use takes no screenshots and reads no clipboard.",
            "The computer tool returns running-app metadata, then accessibility text only from apps you approve for this turn.",
        ),
        (
            "Nothing saves silently",
            "Normal agent requests remain in their thread. A note is only ever written into your vault when you ask for one.",
            "",
        ),
        (
            "App access always needs your approval",
            "A grant is for the named running app and active parent turn only. Stop, Escape, screen lock, sleep, turn completion and quitting Emma revoke it.",
            "Every app asks before access, even in Auto or Full access. Declining blocks that app for the rest of the turn.",
        ),
        (
            "No analytics or crash uploader",
            "Emma records local usage and execution traces but does not configure analytics or crash-report uploads. Providers, update checks, the catalog and enabled integrations still make network requests.",
            "",
        ),
    ];
    let mut prose_view = v_flex()
        .id("privacy-prose")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong);
    for (index, (title, info, copy)) in prose.into_iter().enumerate() {
        let mut row = v_flex()
            .id(format!("privacy-prose-{}", index))
            .gap(theme.spacing.s2)
            .px(theme.spacing.s4)
            .py(theme.spacing.s4)
            .border_b_1()
            .border_color(theme.colors.border)
            .child(mono_heading(title, theme))
            .child(body_copy(info, theme));
        if !copy.is_empty() {
            row = row.child(body_copy(copy, theme));
        }
        if index == 0 {
            row = row.child(settings_button(
                "privacy-openrouter",
                "Review OpenRouter privacy settings ↗",
                Some(SettingsAction::Privacy(
                    PrivacyAction::OpenOpenRouterPrivacy,
                )),
                callback,
                theme,
                cx,
                disabled,
                false,
            ));
        }
        prose_view = prose_view.child(row);
    }
    page_frame(
        SettingsPageId::Privacy,
        state,
        theme,
        v_flex()
            .w_full()
            .gap(theme.spacing.s5)
            .child(section("privacy-reset-section", theme, reset))
            .child(prose_view)
            .child(mono_label(
                format!("Privacy policy endpoint: {}", value.openrouter_url),
                theme,
            )),
    )
}

fn render_about(
    value: &AboutPageState,
    state: &SettingsState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let disabled = state.disabled || state.status.blocks_input();
    let mut credits = v_flex()
        .id("about-credits")
        .w_full()
        .border_1()
        .border_color(theme.colors.border_strong);
    if value.credits.is_empty() {
        credits = credits.child(body_copy("No credits loaded.", theme));
    }
    for (index, credit) in value.credits.iter().enumerate() {
        let mut row = v_flex()
            .id(format!("about-credit-{}", index))
            .gap(theme.spacing.s2)
            .px(theme.spacing.s4)
            .py(theme.spacing.s4)
            .border_b_1()
            .border_color(theme.colors.border)
            .child(mono_heading(credit.title.clone(), theme))
            .child(body_copy(credit.body.clone(), theme));
        if let (Some(href), Some(link)) = (credit.href.clone(), credit.link.clone()) {
            row = row.child(settings_button(
                format!("about-link-{}", index),
                link,
                Some(SettingsAction::About(AboutAction::OpenLink(href))),
                callback,
                theme,
                cx,
                disabled,
                false,
            ));
        }
        credits = credits.child(row);
    }
    page_frame(SettingsPageId::About, state, theme, credits)
}

#[allow(clippy::too_many_arguments)]
fn render_setup_dialog(
    setup: SetupState,
    focus: FocusHandle,
    platform: Platform,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    _window: &mut Window,
    cx: &mut App,
) -> AnyElement {
    let disabled = setup.status.blocks_input();
    let step = setup.step;
    let mut rail = h_flex()
        .id("setup-rail")
        .flex_wrap()
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_b_1()
        .border_color(theme.colors.border);
    for candidate in SetupStep::ALL {
        let active = candidate == step;
        let done = candidate.index() < step.index();
        rail = rail.child(
            h_flex()
                .id(format!("setup-step-{}", candidate.index()))
                .items_center()
                .gap(theme.spacing.s2)
                .text_color(if active {
                    theme.colors.accent
                } else if done {
                    theme.colors.text_2
                } else {
                    theme.colors.text_3
                })
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_2xs)
                .child(format!("{:02}", candidate.index() + 1))
                .child(candidate.label()),
        );
    }
    let body = match step {
        SetupStep::Emma => setup_emma_step(theme),
        SetupStep::Model => setup_model_step(&setup, inputs, callback, theme, cx, disabled),
        SetupStep::QuickAsk => {
            setup_quick_ask_step(&setup, platform, callback, theme, cx, disabled)
        }
        SetupStep::Permissions => {
            setup_permissions_step(&setup, platform, callback, theme, cx, disabled)
        }
        SetupStep::Knowledge => setup_knowledge_step(&setup, inputs, callback, theme, cx, disabled),
        SetupStep::Agents => setup_agents_step(&setup, callback, theme, cx, disabled),
    };
    let mut panel = v_flex()
        .id("setup-dialog")
        .role(Role::Dialog)
        .w(px(700.))
        .max_w_full()
        .max_h(px(760.))
        .overflow_y_scroll()
        .bg(theme.colors.bg)
        .border_1()
        .border_color(theme.colors.border_strong)
        .text_color(theme.colors.text)
        .shadow(vec![theme.shadows.lg.box_shadow()])
        .child(
            h_flex()
                .items_center()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s4)
                .border_b_1()
                .border_color(theme.colors.border)
                .child(
                    div()
                        .w(px(30.))
                        .h(px(30.))
                        .items_center()
                        .justify_center()
                        .bg(theme.colors.accent_soft)
                        .text_color(theme.colors.accent)
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_lg)
                        .child("✦"),
                )
                .child(
                    v_flex()
                        .flex_1()
                        .gap(theme.spacing.s1)
                        .child(mono_label(
                            format!("Setup / {} of 6", step.index() + 1),
                            theme,
                        ))
                        .child(
                            div()
                                .font_family(theme.typography.font_mono.clone())
                                .text_size(theme.typography.fs_2xl)
                                .child(step.label()),
                        ),
                )
                .child(setup_button(
                    "setup-close",
                    "×",
                    Some(SetupAction::Close),
                    callback,
                    theme,
                    cx,
                    false,
                    false,
                )),
        )
        .child(rail)
        .child(body);
    if let Some((kind, message)) = setup.status.label() {
        panel = panel.child(setup_status(kind, message, callback, theme, cx));
    }
    panel = panel.child(
        h_flex()
            .items_center()
            .justify_end()
            .gap(theme.spacing.s2)
            .px(theme.spacing.s4)
            .py(theme.spacing.s4)
            .border_t_1()
            .border_color(theme.colors.border)
            .child(if step != SetupStep::Agents {
                setup_button(
                    "setup-skip",
                    "Skip setup",
                    Some(SetupAction::Skip),
                    callback,
                    theme,
                    cx,
                    disabled,
                    false,
                )
            } else {
                setup_button(
                    "setup-skip-hidden",
                    "",
                    None,
                    callback,
                    theme,
                    cx,
                    true,
                    false,
                )
            })
            .child(if let Some(previous) = step.previous() {
                setup_button(
                    "setup-back",
                    "Back",
                    Some(SetupAction::Back),
                    callback,
                    theme,
                    cx,
                    disabled || previous == step,
                    false,
                )
            } else {
                setup_button(
                    "setup-back-hidden",
                    "",
                    None,
                    callback,
                    theme,
                    cx,
                    true,
                    false,
                )
            })
            .child(setup_button(
                "setup-continue",
                if step == SetupStep::Agents {
                    "Start using Emma"
                } else {
                    "Continue"
                },
                Some(SetupAction::Continue),
                callback,
                theme,
                cx,
                disabled,
                true,
            )),
    );
    div()
        .id("setup-backdrop")
        .absolute()
        .inset_0()
        .items_center()
        .justify_center()
        .bg(theme.colors.bg.alpha(0.86))
        .child(panel.focus_trap("setup-focus-trap", &focus))
        .into_any_element()
}

#[allow(clippy::too_many_arguments)]
fn setup_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    action: Option<SetupAction>,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
    primary: bool,
) -> Button {
    settings_button(
        id,
        label,
        action.map(SettingsAction::Setup),
        callback,
        theme,
        cx,
        disabled,
        primary,
    )
}

fn setup_status(
    kind: &'static str,
    message: SharedString,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
) -> AnyElement {
    let color = match kind {
        "error" | "rollback" => theme.colors.danger,
        "loading" => theme.colors.orange,
        "disabled" => theme.colors.text_3,
        _ => theme.colors.lime,
    };
    let mut row = h_flex()
        .id(format!("setup-status-{}", kind))
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s3)
        .border_l_1()
        .border_color(color)
        .text_color(color)
        .text_size(theme.typography.fs_sm)
        .child(message);
    if matches!(kind, "error" | "rollback") {
        row = row.child(setup_button(
            "setup-retry",
            "Retry",
            Some(SetupAction::Retry),
            callback,
            theme,
            cx,
            false,
            false,
        ));
    }
    row.into_any_element()
}

fn setup_emma_step(theme: &EmmaTheme) -> AnyElement {
    let promises = [
        ("LOCAL", "Threads and durable notes stay on this computer."),
        (
            "VISIBLE",
            "Nothing saves, sends, or controls an app without your say.",
        ),
        (
            "COMPOSABLE",
            "Models, tools, skills, and MCP servers remain yours to choose.",
        ),
        (
            "REVERSIBLE",
            "Every grant and preference can be reviewed or removed later.",
        ),
    ];
    let mut list = v_flex().gap(theme.spacing.s3);
    for (key, line) in promises {
        list = list.child(
            h_flex()
                .items_baseline()
                .gap(theme.spacing.s4)
                .child(mono_label(key, theme))
                .child(body_copy(line, theme)),
        );
    }
    v_flex()
        .id("setup-emma-step")
        .items_center()
        .gap(theme.spacing.s6)
        .px(theme.spacing.s4)
        .py(theme.spacing.s7)
        .child(
            div()
                .w(px(132.))
                .h(px(132.))
                .items_center()
                .justify_center()
                .bg(theme.colors.accent_soft)
                .text_color(theme.colors.accent)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_3xl)
                .child("✦"),
        )
        .child(list)
        .into_any_element()
}

fn setup_model_step(
    setup: &SetupState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let mut body = v_flex()
        .id("setup-model-step")
        .gap(theme.spacing.s4)
        .px(theme.spacing.s4)
        .py(theme.spacing.s4);
    body = body.child(
        section(
            "setup-openrouter-key",
            theme,
            v_flex()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s4)
                .py(theme.spacing.s4)
                .child(
                    h_flex()
                        .items_center()
                        .justify_between()
                        .child(mono_heading("OpenRouter key", theme))
                        .child(mark(
                            if setup.openrouter_saved {
                                SetupMarkState::On
                            } else {
                                SetupMarkState::Off
                            },
                            theme,
                        )),
                )
                .child(body_copy(
                    "One key covers every maker in the catalog. It is encrypted with this computer's credential store and handed to the agent only through its process environment.",
                    theme,
                ))
                .child(mono_label("openrouter.ai/keys ↗", theme))
                .child(mono_label(
                    setup
                        .openrouter_masked
                        .clone()
                        .unwrap_or_else(|| "Not set".into()),
                    theme,
                ))
                .child(
                    h_flex()
                        .items_end()
                        .gap(theme.spacing.s2)
                        .child(field_label(
                            "API key",
                            input_element(
                                inputs,
                                InputId::Credential(0),
                                "OpenRouter API key",
                                "sk-or-v1-…",
                                true,
                                disabled,
                                theme,
                            ),
                            theme,
                        ))
                        .child(setup_button(
                            "setup-save-key",
                            "Save key",
                            Some(SetupAction::SaveOpenRouterKey),
                            callback,
                            theme,
                            cx,
                            disabled,
                            true,
                        ))
                        .child(setup_button(
                            "setup-remove-key",
                            "Remove",
                            Some(SetupAction::RemoveOpenRouterKey),
                            callback,
                            theme,
                            cx,
                            disabled || !setup.openrouter_saved,
                            false,
                        )),
                )
                .child(mono_label(
                    setup
                        .balance
                        .clone()
                        .unwrap_or_else(|| "Balance is checked after saving.".into()),
                    theme,
                )),
        ),
    );
    let mut models = v_flex()
        .id("setup-model-options")
        .gap(theme.spacing.s2)
        .child(mono_heading("Default model", theme))
        .child(body_copy(
            "Every new thread starts on this one. Free models are marked; a router falls through when one is rate limited.",
            theme,
        ));
    if setup.model_options.is_empty() {
        models = models.child(body_copy("No model catalog is ready yet.", theme));
    }
    for option in &setup.model_options {
        models = models.child(
            h_flex()
                .id(format!("setup-model-{}", option.id))
                .items_center()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s3)
                .py(theme.spacing.s2)
                .when(option.active, |this| this.bg(theme.colors.surface_3))
                .child(
                    v_flex()
                        .flex_1()
                        .gap(theme.spacing.s1)
                        .child(mono_heading(option.name.clone(), theme))
                        .child(mono_label(
                            format!("{} · {}", option.maker, option.detail),
                            theme,
                        )),
                )
                .child(if option.free {
                    mono_label("FREE", theme)
                } else {
                    mono_label("", theme)
                })
                .child(setup_button(
                    format!("setup-select-model-{}", option.id),
                    if option.active { "Selected" } else { "Use" },
                    Some(SetupAction::SelectModel(option.id.clone())),
                    callback,
                    theme,
                    cx,
                    disabled || option.active,
                    option.active,
                )),
        );
    }
    body = body.child(section("setup-model-picker", theme, models));
    body = body.child(
        h_flex()
            .items_center()
            .justify_between()
            .gap(theme.spacing.s3)
            .child(body_copy(
                "Verifier, Advisor, Vision, Secrets, and Tagger are optional secondary models. Configure them later in Settings → Models.",
                theme,
            ))
            .child(setup_button(
                "setup-manage-models",
                "Manage models",
                Some(SetupAction::ManageModels),
                callback,
                theme,
                cx,
                disabled,
                false,
            )),
    );
    body.into_any_element()
}

fn setup_quick_ask_step(
    setup: &SetupState,
    platform: Platform,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let lessons = [
        (
            if platform == Platform::Windows {
                "Alt Alt"
            } else {
                "⌥⌥"
            },
            if platform == Platform::Windows {
                "Tap Alt twice to open Quick Ask without leaving the app in front."
            } else {
                "Tap Option twice to open Quick Ask without leaving the app in front."
            },
        ),
        (
            "hold",
            "Hold the space bar while the box is empty, speak, and let go to type the transcript.",
        ),
        (
            "●",
            "The microphone button does the same thing when the overlay is already open.",
        ),
        (
            "orbs",
            "Cursor orbs hang below the overlay and run the quick actions you choose.",
        ),
    ];
    let mut list = v_flex()
        .id("setup-quick-ask-lessons")
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s4);
    for (key, copy) in lessons {
        list = list.child(
            h_flex()
                .items_center()
                .gap(theme.spacing.s4)
                .child(
                    div()
                        .w(px(64.))
                        .h(px(36.))
                        .items_center()
                        .justify_center()
                        .bg(theme.colors.surface_3)
                        .text_color(theme.colors.accent)
                        .font_family(theme.typography.font_mono.clone())
                        .child(key),
                )
                .child(body_copy(copy, theme)),
        );
    }
    list = list.child(
        h_flex()
            .items_center()
            .justify_between()
            .gap(theme.spacing.s3)
            .child(body_copy(
                if setup.quick_ask_tapped {
                    "That is it — Emma is up."
                } else {
                    "Try the gesture once; the app will show the overlay if the platform permits it."
                },
                theme,
            ))
            .child(setup_button(
                "setup-show-quick-ask",
                "Show me ↗",
                Some(SetupAction::ShowQuickAsk),
                callback,
                theme,
                cx,
                disabled,
                true,
            )),
    );
    section("setup-quick-ask-section", theme, list)
}

fn setup_permissions_step(
    setup: &SetupState,
    platform: Platform,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let required = SetupPermissionId::ALL
        .into_iter()
        .filter(|id| !id.unavailable(platform))
        .count();
    let granted = setup
        .permissions
        .iter()
        .filter(|grant| !grant.id.unavailable(platform) && grant.status == Some(true))
        .count();
    let mut body = v_flex()
        .id("setup-permissions-step")
        .gap(theme.spacing.s2)
        .child(mono_label(
            format!(
                "[{}] {} of {} granted · asks one at a time",
                "#".repeat(granted),
                granted,
                required
            ),
            theme,
        ));
    for id in SetupPermissionId::ALL {
        let grant = setup.permissions.iter().find(|grant| grant.id == id);
        let unavailable = id.unavailable(platform);
        let status = grant.and_then(|grant| grant.status);
        let row = h_flex()
            .id(format!("setup-permission-{}", id.id()))
            .items_start()
            .gap(theme.spacing.s3)
            .px(theme.spacing.s3)
            .py(theme.spacing.s3)
            .border_t_1()
            .border_color(theme.colors.border)
            .child(mark(
                if unavailable {
                    SetupMarkState::Unknown
                } else {
                    match status {
                        Some(true) => SetupMarkState::On,
                        Some(false) => SetupMarkState::Off,
                        None => SetupMarkState::Unknown,
                    }
                },
                theme,
            ))
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(theme.spacing.s2)
                    .child(mono_heading(permission_title(id, platform), theme))
                    .child(body_copy(setup_permission_what(id, platform), theme))
                    .child(mono_label(setup_permission_tasks(id, platform), theme)),
            )
            .child(setup_button(
                format!("setup-open-permission-{}", id.id()),
                if unavailable {
                    "Not required"
                } else if status == Some(true) {
                    "Review ↗"
                } else {
                    "Grant ↗"
                },
                Some(SetupAction::OpenCapability(id)),
                callback,
                theme,
                cx,
                disabled || unavailable,
                false,
            ));
        body = body.child(row);
    }
    section("setup-permissions-section", theme, body)
}

fn setup_permission_what(id: SetupPermissionId, platform: Platform) -> SharedString {
    match id {
        SetupPermissionId::Accessibility => {
            if platform == Platform::Windows {
                "Opens Quick Ask on the built-in shortcut and controls apps you approve.".into()
            } else {
                "Lets Emma control apps you approve and open Quick Ask on the built-in shortcut."
                    .into()
            }
        }
        SetupPermissionId::Screen => {
            "Lets Emma save the screen picture you explicitly request.".into()
        }
        SetupPermissionId::Files => {
            if platform == Platform::Windows {
                "Lets Emma write Markdown notes into a folder you choose.".into()
            } else {
                "Lets Emma write one Markdown note into your chosen vault.".into()
            }
        }
        SetupPermissionId::Microphone => {
            "Lets dictation listen only while you hold the voice control.".into()
        }
        SetupPermissionId::Speech => {
            "Lets the operating system transcribe a local utterance.".into()
        }
        SetupPermissionId::Automation => {
            "Lets supported browser metadata be read after you approve the app.".into()
        }
        SetupPermissionId::Notifications => {
            "Lets Emma tell you when a background task finishes.".into()
        }
    }
}

fn setup_permission_tasks(id: SetupPermissionId, platform: Platform) -> SharedString {
    let tasks = match (id, platform) {
        (SetupPermissionId::Accessibility, Platform::Windows) => {
            "Control approved apps · Quick Ask on Alt+Alt · Bound shortcuts"
        }
        (SetupPermissionId::Accessibility, _) => {
            "Control approved apps · Quick Ask on ⌥⌥ · Bound shortcuts"
        }
        (SetupPermissionId::Screen, _) => {
            "Save screen · Read the picture with vision · Write a note"
        }
        (SetupPermissionId::Microphone, _) => "Hold-to-talk dictation · Voice cleanup",
        (SetupPermissionId::Speech, _) => "On-device transcription · Voice recognition",
        (SetupPermissionId::Automation, _) => "Read approved browser metadata · Browser actions",
        (SetupPermissionId::Notifications, _) => "Task finished · Permission required",
        (SetupPermissionId::Files, _) => "Write Markdown notes · Read selected vault files",
    };
    tasks.into()
}

fn setup_knowledge_step(
    setup: &SetupState,
    inputs: &SettingsInputs,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let mut body = v_flex()
        .id("setup-knowledge-step")
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s4);
    body = body.child(
        h_flex()
            .items_center()
            .justify_between()
            .gap(theme.spacing.s3)
            .child(
                v_flex()
                    .flex_1()
                    .min_w_0()
                    .gap(theme.spacing.s2)
                    .child(mono_heading("Where notes are saved", theme))
                    .child(body_copy(
                        "Every save is one Markdown note in a folder you already own: an Obsidian vault, a synced folder, anywhere. Emma keeps no second copy.",
                        theme,
                    )),
            )
            .child(setup_button(
                "setup-pick-vault",
                "Any folder…",
                Some(SetupAction::PickVaultFolder),
                callback,
                theme,
                cx,
                disabled,
                false,
            )),
    );
    if let Some(vault) = setup.vault.clone() {
        body = body.child(section(
            "setup-selected-vault",
            theme,
            v_flex()
                .gap(theme.spacing.s2)
                .px(theme.spacing.s3)
                .py(theme.spacing.s3)
                .child(mono_heading(vault.name, theme))
                .child(mono_label(vault.root, theme))
                .child(mono_label(format!("Folder: {}", vault.folder), theme))
                .child(status_text(
                    if vault.files_ready {
                        "Files ready"
                    } else {
                        "Files permission required"
                    },
                    vault.files_ready,
                    theme,
                )),
        ));
    } else {
        body = body.child(body_copy("No vault yet.", theme));
    }
    body = body.child(field_label(
        "Folder inside the vault",
        input_element(
            inputs,
            InputId::VaultFolder,
            "Vault folder",
            setup
                .vault
                .as_ref()
                .map(|vault| vault.folder.clone())
                .unwrap_or_else(|| "Emma".into()),
            false,
            disabled,
            theme,
        ),
        theme,
    ));
    if !setup.detected_vaults.is_empty() {
        let mut choices = h_flex()
            .id("setup-detected-vaults")
            .flex_wrap()
            .gap(theme.spacing.s2)
            .child(mono_label("Detected vaults", theme));
        for vault in &setup.detected_vaults {
            choices = choices.child(setup_button(
                format!("setup-vault-{}", vault.name),
                vault.name.clone(),
                Some(SetupAction::ChooseVault(vault.root.clone())),
                callback,
                theme,
                cx,
                disabled,
                false,
            ));
        }
        body = body.child(choices);
    }
    section("setup-knowledge-section", theme, body)
}

fn setup_agents_step(
    setup: &SetupState,
    callback: &Option<SettingsCallback>,
    theme: &EmmaTheme,
    cx: &mut App,
    disabled: bool,
) -> AnyElement {
    let selected = setup
        .import_sources
        .iter()
        .filter(|source| source.selected)
        .count();
    let mut body = v_flex()
        .id("setup-agents-step")
        .gap(theme.spacing.s3)
        .px(theme.spacing.s4)
        .py(theme.spacing.s4)
        .child(body_copy(
            "Bring your agent setup from Codex, Claude, Antigravity, Pi, OpenCode, Cursor, Windsurf, or Devin. Emma imports references, not hidden copies.",
            theme,
        ));
    if setup.import_sources.is_empty() {
        body = body.child(body_copy(
            "No agent defaults found. Scan again from Settings → Imports & plugins.",
            theme,
        ));
    }
    for source in &setup.import_sources {
        body = body.child(settings_checkbox(
            format!("setup-import-{}", source.id),
            format!(
                "{} · {} skills · {} MCP",
                source.label, source.skills, source.mcp_configs
            ),
            source.selected,
            Some(SettingsAction::Setup(SetupAction::ToggleImport(
                source.id.clone(),
                source.selected,
            ))),
            callback,
            theme,
            disabled || !source.available,
        ));
    }
    body = body.child(
        h_flex()
            .items_center()
            .justify_between()
            .child(mono_label(
                format!("{} selected · references, not copies", selected),
                theme,
            ))
            .child(setup_button(
                "setup-import-selected",
                "Import selected",
                Some(SetupAction::ImportSelected),
                callback,
                theme,
                cx,
                disabled || selected == 0,
                true,
            )),
    );
    section("setup-agents-section", theme, body)
}

fn async_status_line(value: &SettingsAsyncState) -> SharedString {
    match value {
        SettingsAsyncState::Idle => "Not loaded".into(),
        SettingsAsyncState::Loading => "Loading model catalogs…".into(),
        SettingsAsyncState::Ready => "Ready".into(),
        SettingsAsyncState::Error(message) => message.clone(),
        SettingsAsyncState::Disabled(message) => message.clone(),
        SettingsAsyncState::Rollback(message) => format!("Rollback · {}", message).into(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn settings_pages_match_navigation() {
        let native = navigation::SETTINGS_PAGES
            .iter()
            .map(|page| page.id)
            .collect::<Vec<_>>();
        let typed = SettingsPageId::ALL
            .iter()
            .map(|page| page.id())
            .collect::<Vec<_>>();
        assert_eq!(typed, native);
    }

    #[test]
    fn settings_page_lookup_is_exhaustive() {
        for page in SettingsPageId::ALL {
            assert_eq!(SettingsPageId::from_id(page.id()), Some(page));
            assert_eq!(page.navigation().id, page.id());
        }
    }

    #[test]
    fn validators_reject_unsafe_boundaries() {
        assert!(validate_secret("sk-or-v1-value").is_ok());
        assert!(validate_secret("").is_err());
        assert!(validate_env_name("OPENROUTER_API_KEY").is_ok());
        assert!(validate_env_name("1_NOT_AN_ENV").is_err());
        assert!(validate_vault_folder("Emma/notes").is_ok());
        assert!(validate_vault_folder("../outside").is_err());
        assert!(validate_provider_url("https://api.example.com/v1").is_ok());
        assert!(validate_provider_url("http://example.com/v1").is_err());
    }

    #[test]
    fn setup_has_six_ordered_steps() {
        assert_eq!(SetupStep::ALL.len(), 6);
        for (index, step) in SetupStep::ALL.into_iter().enumerate() {
            assert_eq!(step.index(), index);
            if let Some(previous) = step.previous() {
                assert_eq!(previous.next(), Some(step));
            }
        }
        assert_eq!(SetupStep::ALL[5].next(), None);
    }

    #[test]
    fn windows_omits_macos_only_capabilities() {
        assert!(SetupPermissionId::Accessibility.unavailable(Platform::Windows));
        assert!(SetupPermissionId::Speech.unavailable(Platform::Windows));
        assert!(SetupPermissionId::Automation.unavailable(Platform::Windows));
        assert!(!SetupPermissionId::Screen.unavailable(Platform::Windows));
        assert_eq!(
            permission_title(SetupPermissionId::Screen, Platform::Windows),
            "Screen capture"
        );
    }
}
