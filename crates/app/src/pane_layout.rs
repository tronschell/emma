use serde::{Deserialize, Serialize};

pub const NAV_VIEWS: [&str; 6] = [
    "knowledge",
    "artifacts",
    "scheduled",
    "agent",
    "plugins",
    "research",
];

pub const MIN_BROWSER_WIDTH: f32 = 260.;
pub const WIDE_BROWSER_WIDTH: f32 = 720.;
pub const DEFAULT_TERMINAL_HEIGHT: f32 = 260.;
pub const MIN_TERMINAL_HEIGHT: f32 = 120.;
pub const MAX_TERMINAL_HEIGHT: f32 = 720.;

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneLayout {
    pub sidebar_width: f32,
    pub inspector_width: f32,
    pub browser_width: f32,
    pub sidebar_collapsed: bool,
    pub inspector_collapsed: bool,
    pub browser_open: bool,
    pub terminal_open: bool,
    pub terminal_height: f32,
    pub nav_icons: bool,
    pub nav_order: Vec<String>,
    pub project_order: Vec<String>,
}

impl Default for PaneLayout {
    fn default() -> Self {
        Self {
            sidebar_width: 260.,
            inspector_width: 288.,
            browser_width: 420.,
            sidebar_collapsed: false,
            inspector_collapsed: false,
            browser_open: false,
            terminal_open: false,
            terminal_height: DEFAULT_TERMINAL_HEIGHT,
            nav_icons: false,
            nav_order: Vec::new(),
            project_order: Vec::new(),
        }
    }
}

impl PaneLayout {
    pub fn validated(self, viewport_width: f64) -> Self {
        validate_pane_layout(self, viewport_width)
    }

    pub fn from_value(value: Option<&serde_json::Value>, viewport_width: f64) -> Self {
        parse_pane_layout(value, viewport_width)
    }
}

pub fn validate_pane_layout(mut layout: PaneLayout, viewport_width: f64) -> PaneLayout {
    layout.sidebar_width = bounded_round(layout.sidebar_width as f64, 260., 200., 340.);
    layout.inspector_width = bounded_round(layout.inspector_width as f64, 288., 260., 360.);
    layout.browser_width = bounded_round(
        layout.browser_width as f64,
        420.,
        MIN_BROWSER_WIDTH,
        WIDE_BROWSER_WIDTH,
    );
    layout.terminal_height = bounded_round(
        layout.terminal_height as f64,
        DEFAULT_TERMINAL_HEIGHT,
        MIN_TERMINAL_HEIGHT,
        MAX_TERMINAL_HEIGHT,
    );

    let fixed_width = 320.
        + if layout.sidebar_collapsed { 46. } else { 200. }
        + if layout.inspector_collapsed { 0. } else { 260. }
        + if layout.browser_open {
            MIN_BROWSER_WIDTH as f64
        } else {
            0.
        };
    let requested_slack = if layout.sidebar_collapsed {
        0.
    } else {
        layout.sidebar_width as f64 - 200.
    } + if layout.inspector_collapsed {
        0.
    } else {
        layout.inspector_width as f64 - 260.
    } + if layout.browser_open {
        layout.browser_width as f64 - MIN_BROWSER_WIDTH as f64
    } else {
        0.
    };
    let width = if viewport_width > 0. {
        viewport_width
    } else {
        f64::INFINITY
    };
    let ratio = if requested_slack != 0. {
        ((width.floor() - fixed_width) / requested_slack).clamp(0., 1.)
    } else {
        1.
    };
    if !layout.sidebar_collapsed {
        layout.sidebar_width = (200. + (layout.sidebar_width as f64 - 200.) * ratio).floor() as f32;
    }
    if !layout.inspector_collapsed {
        layout.inspector_width =
            (260. + (layout.inspector_width as f64 - 260.) * ratio).floor() as f32;
    }
    if layout.browser_open {
        layout.browser_width = (MIN_BROWSER_WIDTH as f64
            + (layout.browser_width as f64 - MIN_BROWSER_WIDTH as f64) * ratio)
            .floor() as f32;
    }
    layout
}

pub fn parse_pane_layout(value: Option<&serde_json::Value>, viewport_width: f64) -> PaneLayout {
    let Some(object) = value.and_then(serde_json::Value::as_object) else {
        return validate_pane_layout(PaneLayout::default(), viewport_width);
    };
    let defaults = PaneLayout::default();
    let layout = PaneLayout {
        sidebar_width: json_number(
            object.get("sidebarWidth"),
            defaults.sidebar_width,
            200.,
            340.,
        ),
        inspector_width: json_number(
            object.get("inspectorWidth"),
            defaults.inspector_width,
            260.,
            360.,
        ),
        browser_width: json_number(
            object.get("browserWidth"),
            defaults.browser_width,
            MIN_BROWSER_WIDTH,
            WIDE_BROWSER_WIDTH,
        ),
        sidebar_collapsed: json_bool(object.get("sidebarCollapsed"), defaults.sidebar_collapsed),
        inspector_collapsed: json_bool(
            object.get("inspectorCollapsed"),
            defaults.inspector_collapsed,
        ),
        browser_open: json_bool(object.get("browserOpen"), defaults.browser_open),
        terminal_open: json_bool(object.get("terminalOpen"), defaults.terminal_open),
        terminal_height: json_number(
            object.get("terminalHeight"),
            defaults.terminal_height,
            MIN_TERMINAL_HEIGHT,
            MAX_TERMINAL_HEIGHT,
        ),
        nav_icons: json_bool(object.get("navIcons"), defaults.nav_icons),
        nav_order: json_ids(object.get("navOrder"), Some(&NAV_VIEWS)),
        project_order: json_ids(object.get("projectOrder"), None),
    };
    validate_pane_layout(layout, viewport_width)
}

fn bounded_round(value: f64, fallback: f32, min: f32, max: f32) -> f32 {
    if value.is_finite() {
        value.round().clamp(min as f64, max as f64) as f32
    } else {
        fallback
    }
}

fn json_number(value: Option<&serde_json::Value>, fallback: f32, min: f32, max: f32) -> f32 {
    value
        .and_then(serde_json::Value::as_f64)
        .map_or(fallback, |number| bounded_round(number, fallback, min, max))
}

fn json_bool(value: Option<&serde_json::Value>, fallback: bool) -> bool {
    value
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(fallback)
}

fn json_ids(value: Option<&serde_json::Value>, allowed: Option<&[&str]>) -> Vec<String> {
    let Some(values) = value.and_then(serde_json::Value::as_array) else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for id in values.iter().filter_map(serde_json::Value::as_str) {
        if id.is_empty() || id.encode_utf16().count() > 64 || ids.iter().any(|known| known == id) {
            continue;
        }
        if allowed.is_some_and(|items| !items.contains(&id)) {
            continue;
        }
        ids.push(id.to_owned());
        if ids.len() == 64 {
            break;
        }
    }
    ids
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn defaults_match_renderer_layout() {
        let layout = validate_pane_layout(PaneLayout::default(), f64::INFINITY);
        assert_eq!(layout, PaneLayout::default());
    }

    #[test]
    fn values_clamp_and_round_before_viewport_fit() {
        let layout = parse_pane_layout(
            Some(&json!({
                "sidebarWidth": 10,
                "inspectorWidth": 301.6,
                "sidebarCollapsed": true
            })),
            f64::INFINITY,
        );
        assert_eq!(layout.sidebar_width, 200.);
        assert_eq!(layout.inspector_width, 302.);
        assert!(layout.sidebar_collapsed);
    }

    #[test]
    fn viewport_slack_redistributes_in_renderer_order() {
        let layout = parse_pane_layout(
            Some(&json!({ "sidebarWidth": 340, "inspectorWidth": 360 })),
            900.,
        );
        assert_eq!((layout.sidebar_width, layout.inspector_width), (270., 310.));
        assert!(900. - layout.sidebar_width - layout.inspector_width >= 320.);
    }

    #[test]
    fn invalid_persisted_values_use_field_defaults() {
        let layout = parse_pane_layout(
            Some(&json!({
                "sidebarWidth": "260",
                "terminalHeight": true,
                "navOrder": ["research", "research", "nope", 7, "knowledge"],
                "projectOrder": ["f1", "", "f2"]
            })),
            f64::INFINITY,
        );
        assert_eq!(layout.sidebar_width, 260.);
        assert_eq!(layout.terminal_height, DEFAULT_TERMINAL_HEIGHT);
        assert_eq!(layout.nav_order, ["research", "knowledge"]);
        assert_eq!(layout.project_order, ["f1", "f2"]);
    }
}
