use std::fmt;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum WorkspaceMode {
    Threads,
    Knowledge,
    Artifacts,
    Agent,
    Scheduled,
    Plugins,
    Research,
    Archive,
    Settings,
}

impl WorkspaceMode {
    pub const ALL: [Self; 9] = [
        Self::Threads,
        Self::Knowledge,
        Self::Artifacts,
        Self::Agent,
        Self::Scheduled,
        Self::Plugins,
        Self::Research,
        Self::Archive,
        Self::Settings,
    ];

    pub const NAV: [Self; 6] = [
        Self::Knowledge,
        Self::Artifacts,
        Self::Scheduled,
        Self::Agent,
        Self::Plugins,
        Self::Research,
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Threads => "threads",
            Self::Knowledge => "knowledge",
            Self::Artifacts => "artifacts",
            Self::Agent => "agent",
            Self::Scheduled => "scheduled",
            Self::Plugins => "plugins",
            Self::Research => "research",
            Self::Archive => "archive",
            Self::Settings => "settings",
        }
    }

    pub const fn label(self) -> &'static str {
        match self {
            Self::Threads => "Threads",
            Self::Knowledge => "Knowledge base",
            Self::Artifacts => "Artifacts",
            Self::Agent => "Agent",
            Self::Scheduled => "Scheduled",
            Self::Plugins => "Plugins",
            Self::Research => "Autoresearch",
            Self::Archive => "Archive",
            Self::Settings => "Settings",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "threads" => Some(Self::Threads),
            "knowledge" => Some(Self::Knowledge),
            "artifacts" => Some(Self::Artifacts),
            "agent" => Some(Self::Agent),
            "scheduled" => Some(Self::Scheduled),
            "plugins" => Some(Self::Plugins),
            "research" => Some(Self::Research),
            "archive" => Some(Self::Archive),
            "settings" => Some(Self::Settings),
            _ => None,
        }
    }
}

pub const WORKSPACE_MODES: [&str; 9] = [
    "threads",
    "knowledge",
    "artifacts",
    "agent",
    "scheduled",
    "plugins",
    "research",
    "archive",
    "settings",
];

impl fmt::Display for WorkspaceMode {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.id())
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct NavView {
    pub id: &'static str,
    pub label: &'static str,
    pub hue: &'static str,
}

pub const NAV_VIEWS: [&str; 6] = [
    "knowledge",
    "artifacts",
    "scheduled",
    "agent",
    "plugins",
    "research",
];

pub const NAV_LABELS: [(&str, &str); 6] = [
    ("knowledge", "Knowledge base"),
    ("artifacts", "Artifacts"),
    ("scheduled", "Scheduled"),
    ("agent", "Agent"),
    ("plugins", "Plugins"),
    ("research", "Autoresearch"),
];

pub const NAV_HUE_DEFAULTS: [(&str, &str); 6] = [
    ("knowledge", "teal"),
    ("artifacts", ""),
    ("scheduled", "violet"),
    ("agent", "lime"),
    ("plugins", ""),
    ("research", ""),
];

pub const NAV_VIEW_SPECS: [NavView; 6] = [
    NavView {
        id: "knowledge",
        label: "Knowledge base",
        hue: "teal",
    },
    NavView {
        id: "artifacts",
        label: "Artifacts",
        hue: "",
    },
    NavView {
        id: "scheduled",
        label: "Scheduled",
        hue: "violet",
    },
    NavView {
        id: "agent",
        label: "Agent",
        hue: "lime",
    },
    NavView {
        id: "plugins",
        label: "Plugins",
        hue: "",
    },
    NavView {
        id: "research",
        label: "Autoresearch",
        hue: "",
    },
];

pub fn nav_view(id: &str) -> Option<&'static NavView> {
    NAV_VIEW_SPECS.iter().find(|view| view.id == id)
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum NativeSurface {
    Workspace,
    Annotation,
    Hotspot,
    Radial,
    Run,
    ComputerCursor,
    Overlay,
}

pub const OVERLAY_SURFACES: [&str; 6] = [
    "annotation",
    "hotspot",
    "radial",
    "run",
    "overlay",
    "computerCursor",
];

impl NativeSurface {
    pub const QUERY_KEYS: [&str; 6] = [
        "annotation",
        "hotspot",
        "radial",
        "run",
        "computerCursor",
        "overlay",
    ];

    pub const fn id(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Annotation => "annotation",
            Self::Hotspot => "hotspot",
            Self::Radial => "radial",
            Self::Run => "run",
            Self::ComputerCursor => "computerCursor",
            Self::Overlay => "overlay",
        }
    }

    pub fn from_key(key: &str) -> Option<Self> {
        match key {
            "annotation" => Some(Self::Annotation),
            "hotspot" => Some(Self::Hotspot),
            "radial" => Some(Self::Radial),
            "run" => Some(Self::Run),
            "computerCursor" => Some(Self::ComputerCursor),
            "overlay" => Some(Self::Overlay),
            _ => None,
        }
    }

    pub fn from_query(query: &str) -> Self {
        let query = query.split_once('?').map_or(query, |(_, query)| query);
        for key in [
            "annotation",
            "hotspot",
            "radial",
            "run",
            "computerCursor",
            "overlay",
        ] {
            if query
                .split('&')
                .any(|part| part.split_once('=').map_or(part, |(key, _)| key) == key)
            {
                return Self::from_key(key).expect("native surface key is exhaustive");
            }
        }
        Self::Workspace
    }
}

pub fn is_workspace_window(query: &str) -> bool {
    NativeSurface::from_query(query) == NativeSurface::Workspace
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum OverlaySurface {
    Notch,
    Pill,
    Popout,
}

impl OverlaySurface {
    pub const fn id(self) -> &'static str {
        match self {
            Self::Notch => "notch",
            Self::Pill => "pill",
            Self::Popout => "popout",
        }
    }

    pub fn from_id(id: &str) -> Option<Self> {
        match id {
            "notch" => Some(Self::Notch),
            "pill" => Some(Self::Pill),
            "popout" => Some(Self::Popout),
            _ => None,
        }
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum SettingsCategory {
    Personal,
    Coding,
    Integrations,
    Emma,
}

impl SettingsCategory {
    pub const ALL: [Self; 4] = [Self::Personal, Self::Coding, Self::Integrations, Self::Emma];

    pub const fn label(self) -> &'static str {
        match self {
            Self::Personal => "Personal",
            Self::Coding => "Coding",
            Self::Integrations => "Integrations",
            Self::Emma => "Emma",
        }
    }
}

pub const SETTINGS_CATEGORIES: [&str; 4] = ["Personal", "Coding", "Integrations", "Emma"];

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct SettingsPage {
    pub id: &'static str,
    pub label: &'static str,
    pub windows_label: Option<&'static str>,
    pub copy: &'static str,
    pub category: SettingsCategory,
}

impl SettingsPage {
    pub fn label_for_platform(self, platform: &str) -> &'static str {
        if platform == "win32" {
            match self.windows_label {
                Some(label) => label,
                None => self.label,
            }
        } else {
            self.label
        }
    }

    pub fn copy_for_platform(self, platform: &str) -> &'static str {
        if self.id == "permissions" && platform == "win32" {
            "What Windows lets Emma do"
        } else {
            self.copy
        }
    }
}

pub const SETTINGS_PAGES: [SettingsPage; 15] = [
    SettingsPage {
        id: "keybinds",
        label: "Keybinds",
        windows_label: None,
        copy: "Shortcuts, actions, orbs",
        category: SettingsCategory::Personal,
    },
    SettingsPage {
        id: "notch",
        label: "Notch",
        windows_label: Some("Quick Ask"),
        copy: "Quick Ask model and tasks",
        category: SettingsCategory::Personal,
    },
    SettingsPage {
        id: "voice",
        label: "Voice",
        windows_label: None,
        copy: "Dictation and cleanup",
        category: SettingsCategory::Personal,
    },
    SettingsPage {
        id: "appearance",
        label: "Appearance",
        windows_label: None,
        copy: "Accent colour, section marks, fonts",
        category: SettingsCategory::Personal,
    },
    SettingsPage {
        id: "contextbar",
        label: "Context bar",
        windows_label: None,
        copy: "Arrange the thread inspector",
        category: SettingsCategory::Personal,
    },
    SettingsPage {
        id: "models",
        label: "Models",
        windows_label: None,
        copy: "Picker, keys, and routes",
        category: SettingsCategory::Personal,
    },
    SettingsPage {
        id: "prompts",
        label: "System prompt",
        windows_label: None,
        copy: "Global, and per model",
        category: SettingsCategory::Coding,
    },
    SettingsPage {
        id: "tools",
        label: "Tools",
        windows_label: None,
        copy: "What the agent may call",
        category: SettingsCategory::Integrations,
    },
    SettingsPage {
        id: "permissions",
        label: "Permissions",
        windows_label: None,
        copy: "What macOS lets Emma do",
        category: SettingsCategory::Integrations,
    },
    SettingsPage {
        id: "harness",
        label: "Harness",
        windows_label: None,
        copy: "Experimental context hooks",
        category: SettingsCategory::Coding,
    },
    SettingsPage {
        id: "imports",
        label: "Imports & plugins",
        windows_label: None,
        copy: "Skills and MCP sources",
        category: SettingsCategory::Integrations,
    },
    SettingsPage {
        id: "mobile",
        label: "Mobile",
        windows_label: None,
        copy: "Pair a phone with Emma",
        category: SettingsCategory::Integrations,
    },
    SettingsPage {
        id: "built",
        label: "Built by Emma",
        windows_label: None,
        copy: "What she made for your interface",
        category: SettingsCategory::Emma,
    },
    SettingsPage {
        id: "privacy",
        label: "Data & privacy",
        windows_label: None,
        copy: "Boundaries and reset",
        category: SettingsCategory::Emma,
    },
    SettingsPage {
        id: "about",
        label: "About Emma",
        windows_label: None,
        copy: "Build and architecture",
        category: SettingsCategory::Emma,
    },
];

pub const SETTINGS_PAGE_IDS: [&str; 15] = [
    "keybinds",
    "notch",
    "voice",
    "appearance",
    "contextbar",
    "models",
    "prompts",
    "tools",
    "permissions",
    "harness",
    "imports",
    "mobile",
    "built",
    "privacy",
    "about",
];

pub fn settings_page(id: &str) -> Option<&'static SettingsPage> {
    SETTINGS_PAGES.iter().find(|page| page.id == id)
}

pub fn settings_pages(category: SettingsCategory) -> impl Iterator<Item = &'static SettingsPage> {
    SETTINGS_PAGES
        .iter()
        .filter(move |page| page.category == category)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_modes_preserve_the_renderer_ids_and_labels() {
        let ids: Vec<_> = WorkspaceMode::ALL.iter().map(|mode| mode.id()).collect();
        assert_eq!(
            ids,
            [
                "threads",
                "knowledge",
                "artifacts",
                "agent",
                "scheduled",
                "plugins",
                "research",
                "archive",
                "settings"
            ]
        );
        assert_eq!(WorkspaceMode::Knowledge.label(), "Knowledge base");
        assert_eq!(WorkspaceMode::Research.label(), "Autoresearch");
        for mode in WorkspaceMode::ALL {
            assert_eq!(WorkspaceMode::from_id(mode.id()), Some(mode));
        }
        assert_eq!(WorkspaceMode::from_id("unknown"), None);
    }

    #[test]
    fn nav_views_are_six_reorderable_sections_in_renderer_order() {
        assert_eq!(WorkspaceMode::NAV.map(WorkspaceMode::id), NAV_VIEWS);
        assert_eq!(
            NAV_VIEWS,
            [
                "knowledge",
                "artifacts",
                "scheduled",
                "agent",
                "plugins",
                "research"
            ]
        );
        assert_eq!(
            NAV_VIEW_SPECS
                .iter()
                .map(|view| view.id)
                .collect::<Vec<_>>(),
            NAV_VIEWS
        );
        assert_eq!(
            nav_view("knowledge").map(|view| view.label),
            Some("Knowledge base")
        );
        assert_eq!(nav_view("missing"), None);
    }

    #[test]
    fn native_surface_query_precedence_matches_app_routing() {
        assert_eq!(NativeSurface::from_query(""), NativeSurface::Workspace);
        assert_eq!(
            NativeSurface::from_query("?annotation=1"),
            NativeSurface::Annotation
        );
        assert_eq!(
            NativeSurface::from_query("?hotspot"),
            NativeSurface::Hotspot
        );
        assert_eq!(
            NativeSurface::from_query("?radial=true"),
            NativeSurface::Radial
        );
        assert_eq!(
            NativeSurface::from_query("?run&task=check"),
            NativeSurface::Run
        );
        assert_eq!(
            NativeSurface::from_query("?computerCursor=1"),
            NativeSurface::ComputerCursor
        );
        assert_eq!(
            NativeSurface::from_query("?overlay&surface=pill"),
            NativeSurface::Overlay
        );
        assert_eq!(
            NativeSurface::from_query("?overlay&annotation=1"),
            NativeSurface::Annotation
        );
        assert_eq!(
            NativeSurface::from_query("?other=annotation"),
            NativeSurface::Workspace
        );
    }

    #[test]
    fn settings_pages_preserve_order_categories_copies_and_platform_label() {
        assert_eq!(SETTINGS_PAGES.len(), 15);
        assert_eq!(
            SettingsCategory::ALL.map(SettingsCategory::label),
            ["Personal", "Coding", "Integrations", "Emma"]
        );
        assert_eq!(
            settings_page("keybinds").map(|page| page.copy),
            Some("Shortcuts, actions, orbs")
        );
        assert_eq!(
            settings_page("notch").map(|page| page.label_for_platform("darwin")),
            Some("Notch")
        );
        assert_eq!(
            settings_page("notch").map(|page| page.label_for_platform("win32")),
            Some("Quick Ask")
        );
        assert_eq!(
            settings_page("permissions").map(|page| page.copy_for_platform("darwin")),
            Some("What macOS lets Emma do")
        );
        assert_eq!(
            settings_page("permissions").map(|page| page.copy_for_platform("win32")),
            Some("What Windows lets Emma do")
        );
        assert_eq!(settings_pages(SettingsCategory::Personal).count(), 6);
        assert_eq!(
            settings_pages(SettingsCategory::Coding)
                .map(|page| page.id)
                .collect::<Vec<_>>(),
            ["prompts", "harness"]
        );
        assert_eq!(settings_page("missing"), None);
    }
}
