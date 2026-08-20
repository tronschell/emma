#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OverlayPlacement {
    LeftOfNotch,
    RightOfNotch,
    #[default]
    UnderNotch,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct AppPreferences {
    pub overlay_placement: OverlayPlacement,
    pub capture_screenshot: bool,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn privacy_defaults_do_not_capture_the_screen() {
        let preferences = AppPreferences::default();
        assert!(!preferences.capture_screenshot);
        assert_eq!(preferences.overlay_placement, OverlayPlacement::UnderNotch);
    }
}
