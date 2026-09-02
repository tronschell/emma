use gpui::{
    App, BoxShadow, FontWeight, Global, Hsla, Pixels, Rgba, SharedString, point, px, rgb, rgba,
};

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmmaColors {
    pub bg: Hsla,
    pub surface: Hsla,
    pub surface_2: Hsla,
    pub surface_3: Hsla,
    pub surface_4: Hsla,
    pub text: Hsla,
    pub text_2: Hsla,
    pub text_3: Hsla,
    pub border: Hsla,
    pub border_strong: Hsla,
    pub chrome: Hsla,
    pub rose: Hsla,
    pub orange: Hsla,
    pub lime: Hsla,
    pub yellow: Hsla,
    pub teal: Hsla,
    pub blue: Hsla,
    pub violet: Hsla,
    pub accent: Hsla,
    pub accent_soft: Hsla,
    pub accent_2: Hsla,
    pub danger: Hsla,
    pub danger_surface: Hsla,
    pub solid: Hsla,
    pub solid_hover: Hsla,
    pub fg_invert: Hsla,
}

impl Default for EmmaColors {
    fn default() -> Self {
        Self::dark()
    }
}

impl EmmaColors {
    pub fn dark() -> Self {
        let accent = rgb_hex(0xff6a3d);
        Self {
            bg: rgb_hex(0x0e0e10),
            surface: rgb_hex(0x131316),
            surface_2: rgb_hex(0x17171a),
            surface_3: rgb_hex(0x1c1c20),
            surface_4: rgb_hex(0x232327),
            text: rgb_hex(0xe8e6df),
            text_2: rgba_hex(0xe8e6dfad),
            text_3: rgba_hex(0xe8e6df8c),
            border: rgba_hex(0xe8e6df26),
            border_strong: rgba_hex(0xe8e6df47),
            chrome: rgb_hex(0x131316),
            rose: rgb_hex(0xed7a9b),
            orange: accent,
            lime: rgb_hex(0xc3d64b),
            yellow: rgb_hex(0xe8c34a),
            teal: rgb_hex(0x3fd8c0),
            blue: rgb_hex(0x6faee6),
            violet: rgb_hex(0xae78f0),
            accent,
            accent_soft: accent.alpha(0.14),
            accent_2: oklch_hue_shift(accent, 150.),
            danger: rgb_hex(0xed7a9b),
            danger_surface: rgb_hex(0x2a1620),
            solid: rgb_hex(0xe8e6df),
            solid_hover: rgb_hex(0xf4f2ec),
            fg_invert: rgb_hex(0x0e0e10),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmmaSpacing {
    pub s1: Pixels,
    pub s2: Pixels,
    pub s3: Pixels,
    pub s4: Pixels,
    pub s5: Pixels,
    pub s6: Pixels,
    pub s7: Pixels,
    pub s8: Pixels,
}

impl Default for EmmaSpacing {
    fn default() -> Self {
        Self {
            s1: px(4.),
            s2: px(6.),
            s3: px(8.),
            s4: px(12.),
            s5: px(16.),
            s6: px(20.),
            s7: px(24.),
            s8: px(32.),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmmaRadii {
    pub none: Pixels,
    pub sm: Pixels,
    pub md: Pixels,
    pub lg: Pixels,
    pub xl: Pixels,
    pub full: Pixels,
}

impl Default for EmmaRadii {
    fn default() -> Self {
        Self {
            none: px(0.),
            sm: px(0.),
            md: px(0.),
            lg: px(0.),
            xl: px(0.),
            full: px(999.),
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct EmmaTypography {
    pub font: SharedString,
    pub font_stack: SharedString,
    pub font_mono: SharedString,
    pub font_mono_stack: SharedString,
    pub font_code: SharedString,
    pub font_code_stack: SharedString,
    pub fs_2xs: Pixels,
    pub fs_xs: Pixels,
    pub fs_sm: Pixels,
    pub fs_md: Pixels,
    pub fs_lg: Pixels,
    pub fs_xl: Pixels,
    pub fs_2xl: Pixels,
    pub fs_3xl: Pixels,
    pub line_height: f32,
    pub letter_spacing_caps: f32,
}

impl Default for EmmaTypography {
    fn default() -> Self {
        Self {
            font: "Inter".into(),
            font_stack:
                "Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, \"Segoe UI\", sans-serif"
                    .into(),
            font_mono: "Departure Mono".into(),
            font_mono_stack: "Departure Mono, ui-monospace, SFMono-Regular, Menlo, monospace"
                .into(),
            font_code: "ui-monospace".into(),
            font_code_stack: "ui-monospace, SFMono-Regular, Menlo, monospace".into(),
            fs_2xs: px(10.),
            fs_xs: px(11.),
            fs_sm: px(12.),
            fs_md: px(13.),
            fs_lg: px(14.),
            fs_xl: px(15.),
            fs_2xl: px(17.),
            fs_3xl: px(20.),
            line_height: 1.6,
            letter_spacing_caps: 0.08,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmmaDimensions {
    pub window_width: Pixels,
    pub window_height: Pixels,
    pub window_min_width: Pixels,
    pub window_min_height: Pixels,
    pub sidebar_width: Pixels,
    pub sidebar_min_width: Pixels,
    pub sidebar_max_width: Pixels,
    pub inspector_width: Pixels,
    pub inspector_min_width: Pixels,
    pub inspector_max_width: Pixels,
    pub browser_width: Pixels,
    pub browser_min_width: Pixels,
    pub browser_max_width: Pixels,
    pub sidebar_top_padding: Pixels,
    pub sidebar_row: Pixels,
    pub sidebar_search_height: Pixels,
    pub thread_bar_height: Pixels,
    pub inspector_header_height: Pixels,
    pub transcript_padding: Pixels,
    pub composer_bottom_margin: Pixels,
    pub content_gutter_min: Pixels,
    pub content_gutter_max: Pixels,
    pub content_column: Pixels,
    pub conversation_column_high: Pixels,
    pub prose_column: f32,
    pub prose_column_high: f32,
    pub island_width: Pixels,
    pub island_height: Pixels,
    pub island_inset: Pixels,
    pub island_transcript_max_height: Pixels,
    pub status_pill_size: Pixels,
    pub radial_orb_size: Pixels,
}

impl Default for EmmaDimensions {
    fn default() -> Self {
        Self {
            window_width: px(1380.),
            window_height: px(860.),
            window_min_width: px(1040.),
            window_min_height: px(680.),
            sidebar_width: px(260.),
            sidebar_min_width: px(200.),
            sidebar_max_width: px(340.),
            inspector_width: px(288.),
            inspector_min_width: px(260.),
            inspector_max_width: px(360.),
            browser_width: px(420.),
            browser_min_width: px(260.),
            browser_max_width: px(720.),
            sidebar_top_padding: px(46.),
            sidebar_row: px(28.),
            sidebar_search_height: px(30.),
            thread_bar_height: px(46.),
            inspector_header_height: px(45.),
            transcript_padding: px(20.),
            composer_bottom_margin: px(16.),
            content_gutter_min: px(12.),
            content_gutter_max: px(28.),
            content_column: px(720.),
            conversation_column_high: px(1080.),
            prose_column: 72.,
            prose_column_high: 96.,
            island_width: px(620.),
            island_height: px(97.),
            island_inset: px(20.),
            island_transcript_max_height: px(260.),
            status_pill_size: px(44.),
            radial_orb_size: px(34.),
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct ShadowToken {
    pub offset_x: Pixels,
    pub offset_y: Pixels,
    pub blur_radius: Pixels,
    pub spread_radius: Pixels,
    pub color: Hsla,
}

impl ShadowToken {
    pub fn box_shadow(self) -> BoxShadow {
        BoxShadow {
            color: self.color,
            offset: point(self.offset_x, self.offset_y),
            blur_radius: self.blur_radius,
            spread_radius: self.spread_radius,
            inset: false,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct EmmaShadows {
    pub sm: ShadowToken,
    pub md: ShadowToken,
    pub lg: ShadowToken,
}

impl Default for EmmaShadows {
    fn default() -> Self {
        Self {
            sm: ShadowToken {
                offset_x: px(0.),
                offset_y: px(1.),
                blur_radius: px(2.),
                spread_radius: px(0.),
                color: rgba_hex(0x00000066),
            },
            md: ShadowToken {
                offset_x: px(0.),
                offset_y: px(8.),
                blur_radius: px(24.),
                spread_radius: px(0.),
                color: rgba_hex(0x00000077),
            },
            lg: ShadowToken {
                offset_x: px(0.),
                offset_y: px(24.),
                blur_radius: px(60.),
                spread_radius: px(0.),
                color: rgba_hex(0x000000bb),
            },
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct EmmaMotion {
    pub transition_ms: u16,
}

impl Default for EmmaMotion {
    fn default() -> Self {
        Self { transition_ms: 120 }
    }
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct EmmaTheme {
    pub colors: EmmaColors,
    pub spacing: EmmaSpacing,
    pub radii: EmmaRadii,
    pub typography: EmmaTypography,
    pub dimensions: EmmaDimensions,
    pub shadows: EmmaShadows,
    pub motion: EmmaMotion,
}

impl Global for EmmaTheme {}

impl EmmaTheme {
    pub fn dark() -> Self {
        Self::default()
    }

    pub fn install(self, cx: &mut App) {
        cx.set_global(self);
    }

    pub fn global(cx: &App) -> Option<&Self> {
        cx.try_global::<Self>()
    }

    pub fn component_tokens(&self) -> gpui_component::SemanticThemeTokens {
        let colors = self.colors;
        let mut tokens = gpui_component::SemanticThemeTokens::default();
        tokens.colors.background = colors.bg;
        tokens.colors.foreground = colors.text;
        tokens.colors.surface = colors.surface;
        tokens.colors.surface_foreground = colors.text;
        tokens.colors.primary = colors.accent;
        tokens.colors.primary_foreground = colors.fg_invert;
        tokens.colors.secondary = colors.surface_3;
        tokens.colors.secondary_foreground = colors.text;
        tokens.colors.muted = colors.surface_2;
        tokens.colors.muted_foreground = colors.text_3;
        tokens.colors.accent = colors.accent_soft;
        tokens.colors.accent_foreground = colors.text;
        tokens.colors.destructive = colors.danger;
        tokens.colors.destructive_foreground = colors.fg_invert;
        tokens.colors.border = colors.border;
        tokens.colors.input = colors.border_strong;
        tokens.colors.ring = colors.accent;
        tokens.colors.selection = colors.accent_soft;
        tokens.radius.none = self.radii.none;
        tokens.radius.sm = self.radii.sm;
        tokens.radius.md = self.radii.md;
        tokens.radius.lg = self.radii.lg;
        tokens.radius.xl = self.radii.xl;
        tokens.radius.full = self.radii.full;
        tokens.spacing.xxs = self.spacing.s1;
        tokens.spacing.xs = self.spacing.s2;
        tokens.spacing.sm = self.spacing.s3;
        tokens.spacing.md = self.spacing.s4;
        tokens.spacing.lg = self.spacing.s5;
        tokens.spacing.xl = self.spacing.s7;
        tokens.spacing.xxl = self.spacing.s8;
        tokens.typography.sans = self.typography.font.clone();
        tokens.typography.mono = self.typography.font_mono.clone();
        tokens.typography.xs = component_text_style(self.typography.fs_xs);
        tokens.typography.sm = component_text_style(self.typography.fs_sm);
        tokens.typography.md = component_text_style(self.typography.fs_md);
        tokens.typography.lg = component_text_style(self.typography.fs_lg);
        tokens.typography.xl = component_text_style(self.typography.fs_xl);
        tokens.typography.mono_md = component_text_style(self.typography.fs_md);
        tokens.shadow.sm = vec![self.shadows.sm.box_shadow()];
        tokens.shadow.md = vec![self.shadows.md.box_shadow()];
        tokens.shadow.lg = vec![self.shadows.lg.box_shadow()];
        tokens
    }
}

pub type Theme = EmmaTheme;
pub type Colors = EmmaColors;
pub type Spacing = EmmaSpacing;
pub type Radii = EmmaRadii;
pub type Typography = EmmaTypography;
pub type Dimensions = EmmaDimensions;

fn component_text_style(size: Pixels) -> gpui_component::TextStyleToken {
    gpui_component::TextStyleToken {
        size,
        line_height: size * 1.6,
        weight: FontWeight::NORMAL,
    }
}

fn rgb_hex(value: u32) -> Hsla {
    Hsla::from(rgb(value))
}

fn rgba_hex(value: u32) -> Hsla {
    Hsla::from(rgba(value))
}

fn oklch_hue_shift(color: Hsla, degrees: f32) -> Hsla {
    let rgb = color.to_rgb();
    let (lightness, a, b) = rgb_to_oklab(rgb);
    let chroma = (a * a + b * b).sqrt();
    let hue = b.atan2(a) + degrees.to_radians();
    let (a, b) = (chroma * hue.cos(), chroma * hue.sin());
    Hsla::from(oklab_to_rgb(lightness, a, b, color.a))
}

#[allow(clippy::excessive_precision)]
fn rgb_to_oklab(rgb: Rgba) -> (f32, f32, f32) {
    fn to_linear(channel: f32) -> f32 {
        if channel <= 0.04045 {
            channel / 12.92
        } else {
            ((channel + 0.055) / 1.055).powf(2.4)
        }
    }

    let r = to_linear(rgb.r);
    let g = to_linear(rgb.g);
    let b = to_linear(rgb.b);
    let l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
    let m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
    let s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
    let l = l.cbrt();
    let m = m.cbrt();
    let s = s.cbrt();
    (
        0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
        1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
        0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s,
    )
}

#[allow(clippy::excessive_precision)]
fn oklab_to_rgb(lightness: f32, a: f32, b: f32, alpha: f32) -> Rgba {
    fn from_linear(channel: f32) -> f32 {
        if channel <= 0.0031308 {
            channel * 12.92
        } else {
            1.055 * channel.powf(1. / 2.4) - 0.055
        }
    }

    let l = lightness + 0.3963377774 * a + 0.2158037573 * b;
    let m = lightness - 0.1055613458 * a - 0.0638541728 * b;
    let s = lightness - 0.0894841775 * a - 1.2914855480 * b;
    let l = l * l * l;
    let m = m * m * m;
    let s = s * s * s;
    let r = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s;
    let g = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s;
    let b = -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s;
    Rgba {
        r: from_linear(r).clamp(0., 1.),
        g: from_linear(g).clamp(0., 1.),
        b: from_linear(b).clamp(0., 1.),
        a: alpha,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn dark_palette_matches_renderer_tokens() {
        let theme = EmmaTheme::default();
        assert_rgb(theme.colors.bg, rgb(0x0e0e10));
        assert_rgb(theme.colors.surface_4, rgb(0x232327));
        assert!((theme.colors.text_2.a - 0xad as f32 / 255.).abs() < f32::EPSILON);
        assert!((theme.colors.border.a - 0x26 as f32 / 255.).abs() < f32::EPSILON);
        assert_rgb(theme.colors.danger_surface, rgb(0x2a1620));
    }

    #[test]
    fn scale_and_geometry_match_renderer_contract() {
        let theme = EmmaTheme::default();
        assert_eq!(theme.spacing.s1, px(4.));
        assert_eq!(theme.spacing.s8, px(32.));
        assert_eq!(theme.radii.md, px(0.));
        assert_eq!(theme.typography.fs_2xs, px(10.));
        assert_eq!(theme.typography.fs_3xl, px(20.));
        assert_eq!(theme.dimensions.window_width, px(1380.));
        assert_eq!(theme.dimensions.sidebar_width, px(260.));
        assert_eq!(theme.dimensions.inspector_width, px(288.));
        assert_eq!(theme.dimensions.browser_width, px(420.));
        assert_eq!(theme.dimensions.content_column, px(720.));
        assert_eq!(theme.dimensions.island_width, px(620.));
    }

    fn assert_rgb(actual: Hsla, expected: gpui::Rgba) {
        let actual = actual.to_rgb();
        assert!((actual.r - expected.r).abs() < 0.000001);
        assert!((actual.g - expected.g).abs() < 0.000001);
        assert!((actual.b - expected.b).abs() < 0.000001);
        assert!((actual.a - expected.a).abs() < 0.000001);
    }
}
