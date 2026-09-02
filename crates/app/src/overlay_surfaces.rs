use std::{cell::RefCell, rc::Rc};

use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, ElementId, Entity, FocusHandle, Hsla, InteractiveElement as _, IntoElement,
    MouseButton, ParentElement as _, PathBuilder, RenderOnce, SharedString,
    StatefulInteractiveElement as _, Styled as _, Window, bounds, canvas, div, fill, point, px,
    relative, size, transparent_black,
};
use gpui_component::{
    Disableable as _, Selectable as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex,
    input::{Textarea, TextareaState},
    scroll::ScrollableElement as _,
    v_flex,
};

use crate::{conversation::PermissionMode, navigation::OverlaySurface, theme::EmmaTheme};

pub const ISLAND_WIDTH: f32 = 620.;
pub const ISLAND_HEIGHT: f32 = 97.;
pub const ORB_BAND: f32 = 126.;
pub const HOTSPOT_PAD: f32 = 14.;
pub const HOTSPOT_DROP: f32 = 44.;
pub const MAX_TRANSCRIPT: f32 = 260.;
pub const PILL_SIZE: f32 = 44.;
pub const PILL_MARGIN: f32 = 16.;
pub const POPOUT_BAR: f32 = 28.;
pub const ISLAND_INSET: f32 = 20.;
pub const RADIAL_SIZE: f32 = 260.;
pub const RADIAL_RADIUS: f32 = 88.;
pub const COMPUTER_CURSOR_LIFETIME_MS: u64 = 1400;
pub const PILL_LINGER_MS: u64 = 2400;
pub const PILL_FADE_MS: u64 = 320;
pub const NOTCH_WAVE_BUSY_MS: u64 = 55;
pub const NOTCH_WAVE_IDLE_MS: u64 = 90;

pub type OverlayCallback = Rc<dyn Fn(OverlayAction, &mut Window, &mut App)>;

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct SurfaceRect {
    pub x: f32,
    pub y: f32,
    pub width: f32,
    pub height: f32,
}

impl SurfaceRect {
    pub const fn new(x: f32, y: f32, width: f32, height: f32) -> Self {
        Self {
            x,
            y,
            width,
            height,
        }
    }

    pub fn right(self) -> f32 {
        self.x + self.width
    }

    pub fn bottom(self) -> f32 {
        self.y + self.height
    }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct DisplayGeometry {
    pub bounds: SurfaceRect,
    pub work_area: SurfaceRect,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NotchGeometry {
    pub id: f64,
    pub x: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct NotchPlacement {
    pub left: f32,
    pub width: f32,
    pub height: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct OverlayLayout {
    pub bounds: SurfaceRect,
    pub notch: NotchPlacement,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct PopoutLayout {
    pub bounds: SurfaceRect,
    pub base: f32,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct HotspotLayout {
    pub bounds: SurfaceRect,
    pub hot: SurfaceRect,
    pub notch: NotchPlacement,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct GeometryPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GeometryError;

pub fn overlay_growth(value: f32) -> f32 {
    if value.is_finite() {
        value.round().clamp(0., MAX_TRANSCRIPT)
    } else {
        0.
    }
}

pub fn parse_notch_geometry(line: &str) -> Result<Vec<NotchGeometry>, GeometryError> {
    let value: serde_json::Value = serde_json::from_str(line).map_err(|_| GeometryError)?;
    let Some(entries) = value.as_array() else {
        return Err(GeometryError);
    };
    if entries.len() > 16 {
        return Err(GeometryError);
    }
    entries
        .iter()
        .map(|entry| {
            let Some(object) = entry.as_object() else {
                return Err(GeometryError);
            };
            let id = object.get("id").and_then(serde_json::Value::as_f64);
            let x = object.get("x").and_then(serde_json::Value::as_f64);
            let width = object.get("width").and_then(serde_json::Value::as_f64);
            let height = object.get("height").and_then(serde_json::Value::as_f64);
            let (Some(id), Some(x), Some(width), Some(height)) = (id, x, width, height) else {
                return Err(GeometryError);
            };
            if ![x, width, height].iter().all(|value| value.is_finite()) {
                return Err(GeometryError);
            }
            let notch = NotchGeometry {
                id,
                x: x.round() as f32,
                width: width.round() as f32,
                height: height.round() as f32,
            };
            if !(40. ..=600.).contains(&notch.width) || !(8. ..=120.).contains(&notch.height) {
                return Err(GeometryError);
            }
            Ok(notch)
        })
        .collect()
}

pub fn overlay_layout(
    display: DisplayGeometry,
    notch_gap: f32,
    notch: Option<NotchGeometry>,
) -> OverlayLayout {
    let menu_bar = (display.work_area.y - display.bounds.y).max(0.).round();
    let height = menu_bar
        .max(notch.map_or(0., |value| value.height))
        .max(24.);
    let width = notch.map_or(notch_gap, |value| value.width);
    let x = notch.map_or(
        (display.bounds.width - width)
            .mul_add(0.5, display.bounds.x)
            .round(),
        |value| value.x,
    );
    let island_width = ISLAND_WIDTH.min((display.bounds.width - 16.).max(0.));
    let limit = display.bounds.right() - island_width;
    let left = (x + width * 0.5 - island_width * 0.5)
        .clamp(display.bounds.x, limit)
        .round();
    OverlayLayout {
        bounds: SurfaceRect::new(
            left,
            display.bounds.y,
            island_width,
            height + ISLAND_HEIGHT + ORB_BAND,
        ),
        notch: NotchPlacement {
            left: x - left,
            width,
            height,
        },
    }
}

pub fn pill_layout(display: DisplayGeometry, spot: Option<GeometryPoint>) -> SurfaceRect {
    let area = display.work_area;
    let x = spot.map_or(area.right() - PILL_SIZE - PILL_MARGIN, |value| value.x);
    let y = spot.map_or(area.y + PILL_MARGIN, |value| value.y);
    SurfaceRect::new(
        x.round()
            .clamp(area.x, (area.right() - PILL_SIZE).max(area.x)),
        y.round()
            .clamp(area.y, (area.bottom() - PILL_SIZE).max(area.y)),
        PILL_SIZE,
        PILL_SIZE,
    )
}

pub fn popout_layout(display: DisplayGeometry, pill: GeometryPoint, grow: f32) -> PopoutLayout {
    let area = display.work_area;
    let width = ISLAND_WIDTH.min(area.width.max(0.));
    let base = POPOUT_BAR + ISLAND_HEIGHT;
    let height = (base + overlay_growth(grow)).min(area.height.max(0.));
    PopoutLayout {
        bounds: SurfaceRect::new(
            (pill.x - ISLAND_INSET)
                .round()
                .clamp(area.x, (area.right() - width).max(area.x)),
            pill.y
                .round()
                .clamp(area.y, (area.bottom() - height).max(area.y)),
            width,
            height,
        ),
        base,
    }
}

pub fn near_bounds(bounds: SurfaceRect, point: GeometryPoint, pad: f32) -> bool {
    point.x >= bounds.x - pad
        && point.x <= bounds.right() + pad
        && point.y >= bounds.y - pad
        && point.y <= bounds.bottom() + pad
}

pub fn hotspot_poll_delay(warm: bool) -> u64 {
    if warm { 120 } else { 250 }
}

pub fn hotspot_layout(display: DisplayGeometry, notch: NotchGeometry) -> HotspotLayout {
    let menu_bar = (display.work_area.y - display.bounds.y).max(0.).round();
    let height = menu_bar.max(notch.height);
    HotspotLayout {
        bounds: SurfaceRect::new(
            notch.x - HOTSPOT_PAD,
            display.bounds.y,
            notch.width + HOTSPOT_PAD * 2.,
            height + HOTSPOT_DROP,
        ),
        hot: SurfaceRect::new(notch.x, display.bounds.y, notch.width, height),
        notch: NotchPlacement {
            left: HOTSPOT_PAD,
            width: notch.width,
            height,
        },
    }
}

pub fn radial_window_layout(display: DisplayGeometry, cursor: GeometryPoint) -> SurfaceRect {
    SurfaceRect::new(
        (cursor.x - RADIAL_SIZE * 0.5).round().clamp(
            display.bounds.x,
            (display.bounds.right() - RADIAL_SIZE).max(display.bounds.x),
        ),
        (cursor.y - RADIAL_SIZE * 0.5).round().clamp(
            display.bounds.y,
            (display.bounds.bottom() - RADIAL_SIZE).max(display.bounds.y),
        ),
        RADIAL_SIZE,
        RADIAL_SIZE,
    )
}

pub const ANNOTATION_SETTLE_MS: u64 = 700;

#[derive(Clone, Debug, PartialEq)]
pub struct NotchWaveState {
    pub width: f32,
    pub busy: bool,
    pub frame: u64,
    pub reduced_motion: bool,
}

impl Default for NotchWaveState {
    fn default() -> Self {
        Self {
            width: 180.,
            busy: false,
            frame: 0,
            reduced_motion: false,
        }
    }
}

#[derive(IntoElement)]
pub struct NotchWave {
    state: NotchWaveState,
    notch: NotchPlacement,
}

impl NotchWave {
    pub fn new(state: NotchWaveState, notch: NotchPlacement) -> Self {
        Self { state, notch }
    }
}

impl RenderOnce for NotchWave {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let frame = if self.state.reduced_motion {
            0
        } else {
            self.state.frame
        };
        let rows = wave_rows(self.state.width, self.state.busy, frame);
        v_flex()
            .id("notch-wave")
            .absolute()
            .left(px(self.notch.left))
            .top(px(self.notch.height))
            .w(px(self.notch.width))
            .items_center()
            .text_color(theme.colors.text_3)
            .font_family(theme.typography.font_mono.clone())
            .text_size(px(11.))
            .line_height(relative(0.82))
            .children(rows.into_iter().enumerate().map(|(index, row)| {
                div()
                    .id(format!("notch-wave-row-{index}"))
                    .max_w_full()
                    .overflow_hidden()
                    .text_color(match index {
                        0 => theme.colors.orange,
                        _ => theme.colors.teal,
                    })
                    .child(row)
            }))
    }
}

fn wave_rows(width: f32, busy: bool, frame: u64) -> Vec<String> {
    let columns = (width / 6.).round().max(12.) as usize;
    let ramp = [' ', '·', '∙', '░', '▒', '▓'];
    (0..2)
        .map(|row| {
            (0..columns)
                .map(|column| {
                    let ratio = column as f32 / (columns.saturating_sub(1).max(1) as f32);
                    let edge = 1. - ((ratio * 2. - 1.).abs()).powf(2.4 - row as f32 * 0.9);
                    let phase = frame as f32;
                    let tongue = 0.74
                        + 0.26
                            * (column as f32 * 0.55 - phase * 0.7).sin()
                            * (column as f32 * 0.19 + phase * 0.31).sin();
                    let flicker = ((column as f32 + 1.) * 12.9898
                        + (row as f32 + 1.) * 4.1414
                        + phase * if busy { 1.4 } else { 0.9 })
                    .sin()
                    .abs();
                    let level = (edge
                        * tongue
                        * (1. - row as f32 * 0.42)
                        * ramp.len() as f32
                        * (0.7 + flicker * 0.7))
                        .round()
                        .clamp(0., (ramp.len() - 1) as f32)
                        as usize;
                    ramp[level]
                })
                .collect()
        })
        .collect()
}

#[derive(IntoElement)]
pub struct NotchHotspot {
    notch: NotchPlacement,
    hover: bool,
    wave_frame: u64,
    reduced_motion: bool,
    callback: Option<OverlayCallback>,
}

impl NotchHotspot {
    pub fn new(notch: NotchPlacement) -> Self {
        Self {
            notch,
            hover: false,
            wave_frame: 0,
            reduced_motion: false,
            callback: None,
        }
    }

    pub fn hover(mut self, hover: bool) -> Self {
        self.hover = hover;
        self
    }

    pub fn wave_frame(mut self, frame: u64) -> Self {
        self.wave_frame = frame;
        self
    }

    pub fn reduced_motion(mut self, reduced_motion: bool) -> Self {
        self.reduced_motion = reduced_motion;
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(OverlayAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for NotchHotspot {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let callback = self.callback;
        let button = Button::new("notch-hotspot")
            .ghost()
            .small()
            .rounded(theme.radii.none)
            .absolute()
            .left(px(self.notch.left))
            .top_0()
            .w(px(self.notch.width))
            .h(px(self.notch.height))
            .opacity(if self.hover { 1. } else { 0. })
            .role(gpui::accesskit::Role::Button)
            .accessibility_label("Open Emma Quick Ask")
            .tab_index(0)
            .when_some(callback, |this, callback| {
                this.on_click(move |_, window, cx| {
                    callback(OverlayAction::OpenOverlay, window, cx);
                })
            });
        let mut root = div()
            .id("notch-hotspot-surface")
            .relative()
            .size_full()
            .child(button);
        if self.hover {
            root = root.child(NotchWave::new(
                NotchWaveState {
                    width: self.notch.width,
                    busy: false,
                    frame: self.wave_frame,
                    reduced_motion: self.reduced_motion,
                },
                self.notch,
            ));
        }
        root
    }
}

#[derive(IntoElement)]
pub struct RadialCommands {
    commands: Vec<OrbCommand>,
    selected: Option<usize>,
    radius: f32,
    reduced_motion: bool,
    focus: Option<FocusHandle>,
    callback: Option<OverlayCallback>,
}

impl RadialCommands {
    pub fn new(commands: impl IntoIterator<Item = OrbCommand>) -> Self {
        Self {
            commands: commands.into_iter().collect(),
            selected: None,
            radius: RADIAL_RADIUS,
            reduced_motion: false,
            focus: None,
            callback: None,
        }
    }

    pub fn selected(mut self, selected: Option<usize>) -> Self {
        self.selected = selected;
        self
    }

    pub fn radius(mut self, radius: f32) -> Self {
        self.radius = radius.max(0.);
        self
    }

    pub fn reduced_motion(mut self, reduced_motion: bool) -> Self {
        self.reduced_motion = reduced_motion;
        self
    }

    pub fn focus_handle(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(OverlayAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for RadialCommands {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let focus = self.focus.unwrap_or_else(|| cx.focus_handle());
        let command_ids = self
            .commands
            .iter()
            .take(8)
            .map(|command| command.id.clone())
            .collect::<Vec<_>>();
        let key_callback = self.callback.clone();
        let key_ids = command_ids.clone();
        let key_selected = self.selected.unwrap_or(0);
        let count = self.commands.len().clamp(1, 8) as f32;
        let mut root = div()
            .id("radial-commands")
            .relative()
            .size_full()
            .role(gpui::accesskit::Role::Menu)
            .aria_label("Emma context commands")
            .track_focus(&focus)
            .tab_index(0)
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key.as_str() == "escape" {
                    emit(&key_callback, OverlayAction::DismissOverlay, window, cx);
                    return;
                }
                if key_ids.is_empty() {
                    return;
                }
                let delta = match event.keystroke.key.as_str() {
                    "left" | "up" => -1,
                    "right" | "down" => 1,
                    _ => return,
                };
                let index =
                    (key_selected as isize + delta).rem_euclid(key_ids.len() as isize) as usize;
                emit(
                    &key_callback,
                    OverlayAction::SelectOrb(key_ids[index].clone()),
                    window,
                    cx,
                );
            });
        for (index, command) in self.commands.into_iter().take(8).enumerate() {
            let angle =
                index as f32 / count * 2. * std::f32::consts::PI - std::f32::consts::PI * 0.5;
            let center = RADIAL_SIZE * 0.5;
            let x = center + angle.cos() * self.radius - 42.;
            let y = center + angle.sin() * self.radius - 24.;
            let selected = self.selected == Some(index);
            let callback = self.callback.clone();
            let id = command.id.clone();
            let mut button = Button::new(format!("radial-command-{index}"))
                .ghost()
                .small()
                .rounded(theme.radii.none)
                .absolute()
                .left(px(x))
                .top(px(y))
                .w(px(84.))
                .items_center()
                .gap(theme.spacing.s2)
                .selected(selected)
                .disabled(command.disabled)
                .role(gpui::accesskit::Role::MenuItem)
                .accessibility_label(command.label.clone())
                .child(
                    div()
                        .id(format!("radial-orb-{index}"))
                        .w(px(34.))
                        .h(px(34.))
                        .items_center()
                        .justify_center()
                        .border_1()
                        .border_color(if selected {
                            theme.colors.accent
                        } else {
                            theme.colors.border_strong
                        })
                        .bg(if selected {
                            theme.colors.accent_soft
                        } else {
                            theme.colors.bg
                        })
                        .text_color(orb_color(index, &theme))
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_sm)
                        .child(command.glyph.clone()),
                )
                .child(
                    div()
                        .max_w(px(84.))
                        .text_color(theme.colors.text_2)
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_2xs)
                        .child(command.label.clone()),
                );
            if let Some(callback) = callback {
                button = button.on_click(move |_, window, cx| {
                    callback(OverlayAction::SelectOrb(id.clone()), window, cx);
                });
            }
            root = root.child(button);
        }
        root
    }
}

#[derive(IntoElement)]
pub struct ScreenAnnotationSurface {
    state: AnnotationState,
    focus: Option<FocusHandle>,
    callback: Option<OverlayCallback>,
}

impl ScreenAnnotationSurface {
    pub fn new(state: AnnotationState) -> Self {
        Self {
            state,
            focus: None,
            callback: None,
        }
    }

    pub fn focus_handle(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(OverlayAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for ScreenAnnotationSurface {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let focus = self.focus.unwrap_or_else(|| cx.focus_handle());
        let state = self.state;
        let callback = self.callback;
        let key_callback = callback.clone();
        let begin_callback = callback.clone();
        let draw_callback = callback.clone();
        let end_callback = callback.clone();
        let strokes = state.strokes.clone();
        let annotation_color: Hsla = gpui::rgb(0xffe84f).into();
        let annotation_glow: Hsla = gpui::rgb(0xfff46b).into();
        let canvas_surface = div()
            .id("annotation-canvas")
            .absolute()
            .inset_0()
            .cursor_crosshair()
            .role(gpui::accesskit::Role::Canvas)
            .aria_label("Draw yellow screen highlights")
            .on_mouse_down(MouseButton::Left, move |event, window, cx| {
                emit(
                    &begin_callback,
                    OverlayAction::AnnotationBegin(AnnotationPoint {
                        x: event.position.x.into(),
                        y: event.position.y.into(),
                    }),
                    window,
                    cx,
                );
            })
            .on_mouse_move(move |event, window, cx| {
                if event.dragging() {
                    emit(
                        &draw_callback,
                        OverlayAction::AnnotationDraw(AnnotationPoint {
                            x: event.position.x.into(),
                            y: event.position.y.into(),
                        }),
                        window,
                        cx,
                    );
                }
            })
            .on_mouse_up(MouseButton::Left, move |_, window, cx| {
                emit(&end_callback, OverlayAction::AnnotationEnd, window, cx);
            })
            .child(render_annotation_canvas(
                strokes,
                annotation_color,
                annotation_glow,
                state.reduced_motion,
            ));
        let mut toolbar = h_flex()
            .id("annotation-toolbar")
            .absolute()
            .top(theme.spacing.s5)
            .left_0()
            .right_0()
            .justify_center()
            .items_center()
            .gap(theme.spacing.s4)
            .min_h(px(40.))
            .px(theme.spacing.s3)
            .py(theme.spacing.s2)
            .bg(theme.colors.bg)
            .border_1()
            .border_color(theme.colors.border_strong)
            .shadow(vec![theme.shadows.lg.box_shadow()]);
        toolbar = toolbar.child(
            v_flex()
                .id("annotation-toolbar-copy")
                .gap(theme.spacing.s1)
                .min_w(px(170.))
                .child(
                    div()
                        .text_color(theme.colors.text_2)
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_2xs)
                        .child("YELLOW HIGHLIGHT"),
                )
                .child(
                    div()
                        .max_w(px(210.))
                        .text_color(theme.colors.text_2)
                        .font_family(theme.typography.font.clone())
                        .text_size(theme.typography.fs_sm)
                        .line_height(relative(1.4))
                        .child("Draw on your live screen · attaches when you stop · Esc cancels"),
                ),
        );
        toolbar = toolbar.child(control_button(
            "annotation-cancel",
            "Cancel",
            OverlayAction::CancelAnnotation,
            false,
            &callback,
            &theme,
        ));
        toolbar = toolbar.child(
            control_button(
                "annotation-attach",
                "Attach",
                OverlayAction::FinishAnnotation,
                !state.drawn,
                &callback,
                &theme,
            )
            .text_color(theme.colors.accent)
            .border_1()
            .border_color(theme.colors.accent.alpha(0.55)),
        );
        let mut root = div()
            .id("screen-annotation")
            .relative()
            .size_full()
            .track_focus(&focus)
            .border_1()
            .border_color(theme.colors.accent.alpha(0.55))
            .cursor_crosshair()
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key.as_str() == "escape" {
                    emit(&key_callback, OverlayAction::CancelAnnotation, window, cx);
                }
            })
            .child(canvas_surface)
            .child(toolbar);
        if let Some(error) = state.error {
            root = root.child(
                div()
                    .id("annotation-error")
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom(theme.spacing.s6)
                    .w_auto()
                    .px(theme.spacing.s3)
                    .py(theme.spacing.s2)
                    .bg(theme.colors.bg)
                    .border_1()
                    .border_color(theme.colors.border_strong)
                    .text_color(theme.colors.danger)
                    .text_size(theme.typography.fs_sm)
                    .role(gpui::accesskit::Role::Alert)
                    .aria_label(error.clone())
                    .child(error),
            );
        }
        root
    }
}

fn render_annotation_canvas(
    strokes: Vec<AnnotationStroke>,
    color: Hsla,
    glow_color: Hsla,
    reduced_motion: bool,
) -> AnyElement {
    canvas(
        move |_, _, _| (strokes, color, glow_color, reduced_motion),
        move |area, (strokes, color, glow_color, reduced_motion), window, _| {
            for stroke in strokes {
                if stroke.points.len() < 2 {
                    continue;
                }
                let mut ink = PathBuilder::stroke(px(5.));
                let mut glow = PathBuilder::stroke(px(14.));
                let origin = area.origin;
                let first = point(
                    origin.x + px(stroke.points[0].x),
                    origin.y + px(stroke.points[0].y),
                );
                ink.move_to(first);
                glow.move_to(first);
                for position in stroke.points.iter().skip(1) {
                    let next = point(origin.x + px(position.x), origin.y + px(position.y));
                    ink.line_to(next);
                    glow.line_to(next);
                }
                if !reduced_motion && let Ok(path) = glow.build() {
                    window.paint_path(path, glow_color.alpha(0.55));
                }
                if let Ok(path) = ink.build() {
                    window.paint_path(path, color);
                }
            }
        },
    )
    .absolute()
    .inset_0()
    .into_any_element()
}

#[derive(IntoElement)]
pub struct ComputerRunBanner {
    task: SharedString,
    max_steps: u32,
    progress: ComputerProgress,
    focus: Option<FocusHandle>,
    callback: Option<OverlayCallback>,
}

impl ComputerRunBanner {
    pub fn new(task: impl Into<SharedString>, max_steps: u32) -> Self {
        Self {
            task: task.into(),
            max_steps,
            progress: ComputerProgress::default(),
            focus: None,
            callback: None,
        }
    }

    pub fn progress(mut self, progress: ComputerProgress) -> Self {
        self.progress = progress;
        self
    }

    pub fn focus_handle(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(OverlayAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for ComputerRunBanner {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let key_callback = self.callback.clone();
        let max_steps = self.max_steps;
        let app = self
            .progress
            .app
            .clone()
            .map_or_else(String::new, |app| format!(" in {app}"));
        let action = self.progress.action.clone();
        let actions = self.progress.actions;
        let step = self.progress.step;
        let task = self.task;
        let mut root = h_flex()
            .id("run-banner")
            .relative()
            .m(px(4.))
            .h_full()
            .px(theme.spacing.s3)
            .gap(theme.spacing.s3)
            .items_center()
            .bg(theme.colors.bg)
            .border_1()
            .border_color(theme.colors.border_strong)
            .shadow(vec![theme.shadows.lg.box_shadow()])
            .role(gpui::accesskit::Role::Status)
            .aria_label("Emma computer run status")
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key.as_str() == "escape" {
                    emit(&key_callback, OverlayAction::StopComputerRun, window, cx);
                }
            })
            .child(
                div()
                    .id("run-banner-pulse")
                    .w(px(6.))
                    .h(px(6.))
                    .flex_none()
                    .bg(theme.colors.accent),
            )
            .child(
                v_flex()
                    .id("run-banner-body")
                    .min_w_0()
                    .flex_1()
                    .gap(px(2.))
                    .child(
                        div()
                            .truncate()
                            .text_color(theme.colors.text)
                            .text_size(theme.typography.fs_sm)
                            .child(format!("Emma · {action}{app}")),
                    )
                    .child(
                        div()
                            .truncate()
                            .text_color(theme.colors.text_3)
                            .font_family(theme.typography.font_mono.clone())
                            .text_size(theme.typography.fs_2xs)
                            .child(format!(
                                "Step {step}/{max_steps} · {actions} action{} · {task}",
                                if actions == 1 { "" } else { "s" }
                            )),
                    ),
            )
            .child(
                control_button(
                    "run-banner-stop",
                    "Stop · esc",
                    OverlayAction::StopComputerRun,
                    false,
                    &self.callback,
                    &theme,
                )
                .text_color(theme.colors.accent)
                .border_1()
                .border_color(theme.colors.accent.alpha(0.55))
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_xs),
            );
        if let Some(focus) = self.focus {
            root = root.track_focus(&focus);
        }
        root
    }
}

#[derive(IntoElement)]
pub struct ComputerActivityCursor {
    progress: Option<ComputerProgress>,
}

impl ComputerActivityCursor {
    pub fn new() -> Self {
        Self { progress: None }
    }

    pub fn progress(mut self, progress: ComputerProgress) -> Self {
        self.progress = Some(progress);
        self
    }
}

impl Default for ComputerActivityCursor {
    fn default() -> Self {
        Self::new()
    }
}

impl RenderOnce for ComputerActivityCursor {
    fn render(self, _: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let mut root = div()
            .id("computer-cursor-surface")
            .relative()
            .size_full()
            .overflow_hidden();
        let Some(progress) = self.progress else {
            return root;
        };
        let Some(cursor) = progress.cursor else {
            return root;
        };
        let x = cursor.x - cursor.bounds.x;
        let y = cursor.y - cursor.bounds.y;
        let left = x > cursor.bounds.width - 210.;
        let above = y > cursor.bounds.height - 75.;
        let mut pointer = div()
            .id(format!("computer-cursor-{}", cursor.window_id))
            .absolute()
            .left(px(x))
            .top(px(y))
            .w(px(27.))
            .h(px(34.))
            .child(render_cursor_arrow(theme.colors.accent, theme.colors.text));
        if !matches!(progress.motion, CursorMotion::Reduced) {
            pointer = pointer.child(
                div()
                    .id("computer-cursor-ring")
                    .absolute()
                    .left(px(-10.))
                    .top(px(-10.))
                    .w(px(20.))
                    .h(px(20.))
                    .rounded(theme.radii.full)
                    .border_1()
                    .border_color(theme.colors.accent),
            );
        }
        let label_left = if left { -202. } else { 16. };
        let label_top = if above { -54. } else { 28. };
        pointer = pointer.child(
            h_flex()
                .id("computer-cursor-label")
                .absolute()
                .left(px(label_left))
                .top(px(label_top))
                .w(px(190.))
                .max_w(px(190.))
                .items_center()
                .gap(theme.spacing.s3)
                .px(theme.spacing.s2)
                .py(theme.spacing.s2)
                .bg(theme.colors.bg)
                .border_1()
                .border_color(theme.colors.accent)
                .shadow(vec![theme.shadows.md.box_shadow()])
                .text_size(theme.typography.fs_xs)
                .child(
                    div()
                        .text_color(theme.colors.accent)
                        .font_weight(gpui::FontWeight::SEMIBOLD)
                        .child("Emma"),
                )
                .child(
                    div()
                        .min_w_0()
                        .flex_1()
                        .truncate()
                        .text_color(theme.colors.text)
                        .child(progress.action),
                ),
        );
        root = root.child(pointer);
        root
    }
}

fn render_cursor_arrow(color: Hsla, stroke_color: Hsla) -> AnyElement {
    canvas(
        move |_, _, _| (color, stroke_color),
        move |area, (color, stroke_color), window, _| {
            let origin = area.origin;
            let vertices = [
                point(origin.x + px(1.), origin.y + px(1.)),
                point(origin.x + px(23.), origin.y + px(19.)),
                point(origin.x + px(13.), origin.y + px(20.)),
                point(origin.x + px(9.), origin.y + px(30.)),
            ];
            let mut fill_path = PathBuilder::fill();
            fill_path.add_polygon(&vertices, true);
            if let Ok(path) = fill_path.build() {
                window.paint_path(path, color);
            }
            let mut outline_path = PathBuilder::stroke(px(1.5));
            outline_path.add_polygon(&vertices, true);
            if let Ok(path) = outline_path.build() {
                window.paint_path(path, stroke_color);
            }
        },
    )
    .w(px(27.))
    .h(px(34.))
    .into_any_element()
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum OverlayRole {
    #[default]
    User,
    Assistant,
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OverlayStep {
    pub id: SharedString,
    pub title: SharedString,
    pub kind: SharedString,
    pub status: SharedString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OverlayChoice {
    pub label: SharedString,
    pub action: OverlayAction,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OverlayTurn {
    pub role: OverlayRole,
    pub content: SharedString,
    pub steps: Vec<OverlayStep>,
    pub choices: Vec<OverlayChoice>,
}

impl OverlayTurn {
    pub fn user(content: impl Into<SharedString>) -> Self {
        Self {
            role: OverlayRole::User,
            content: content.into(),
            steps: Vec::new(),
            choices: Vec::new(),
        }
    }

    pub fn assistant(content: impl Into<SharedString>) -> Self {
        Self {
            role: OverlayRole::Assistant,
            content: content.into(),
            steps: Vec::new(),
            choices: Vec::new(),
        }
    }

    pub fn steps(mut self, steps: impl IntoIterator<Item = OverlayStep>) -> Self {
        self.steps.extend(steps);
        self
    }

    pub fn choices(mut self, choices: impl IntoIterator<Item = OverlayChoice>) -> Self {
        self.choices.extend(choices);
        self
    }
}

#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct OverlayStream {
    pub text: SharedString,
    pub steps: Vec<OverlayStep>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OverlayModel {
    pub key: SharedString,
    pub label: SharedString,
    pub brand: Option<SharedString>,
    pub route: Option<SharedString>,
    pub thinking: Option<SharedString>,
}

impl Default for OverlayModel {
    fn default() -> Self {
        Self {
            key: SharedString::new_static(""),
            label: SharedString::new_static("Model"),
            brand: None,
            route: None,
            thinking: None,
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct AnnotationAttachment {
    pub id: SharedString,
    pub image: Option<SharedString>,
    pub source_application: Option<SharedString>,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct AnnotationPoint {
    pub x: f32,
    pub y: f32,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnnotationStroke {
    pub points: Vec<AnnotationPoint>,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct AnnotationState {
    pub strokes: Vec<AnnotationStroke>,
    pub drawn: bool,
    pub error: Option<SharedString>,
    pub reduced_motion: bool,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum PillStatus {
    #[default]
    Working,
    Error,
    Done,
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum CursorMotion {
    #[default]
    Glide,
    Reduced,
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComputerCursor {
    pub window_id: u64,
    pub bounds: SurfaceRect,
    pub x: f32,
    pub y: f32,
}

impl ComputerCursor {
    pub fn valid(&self) -> bool {
        self.window_id > 0
            && self.window_id <= u32::MAX as u64
            && [self.x, self.y, self.bounds.x, self.bounds.y]
                .iter()
                .all(|value| value.is_finite() && value.abs() <= 100_000.)
            && self.bounds.width.is_finite()
            && self.bounds.width > 0.
            && self.bounds.width <= 16_384.
            && self.bounds.height.is_finite()
            && self.bounds.height > 0.
            && self.bounds.height <= 16_384.
            && self.x >= self.bounds.x
            && self.x < self.bounds.right()
            && self.y >= self.bounds.y
            && self.y < self.bounds.bottom()
    }

    pub fn rounded(&self) -> Option<Self> {
        let x = self.bounds.x.floor();
        let y = self.bounds.y.floor();
        let width = (self.bounds.x + self.bounds.width).ceil() - x;
        let height = (self.bounds.y + self.bounds.height).ceil() - y;
        let rounded = Self {
            window_id: self.window_id,
            bounds: SurfaceRect::new(x, y, width, height),
            x: self.x,
            y: self.y,
        };
        rounded.valid().then_some(rounded)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct ComputerProgress {
    pub step: u32,
    pub action: SharedString,
    pub actions: u32,
    pub app: Option<SharedString>,
    pub cursor: Option<ComputerCursor>,
    pub motion: CursorMotion,
}

impl Default for ComputerProgress {
    fn default() -> Self {
        Self {
            step: 0,
            action: SharedString::new_static("Starting"),
            actions: 0,
            app: None,
            cursor: None,
            motion: CursorMotion::Glide,
        }
    }
}

impl ComputerProgress {
    pub fn valid(&self) -> bool {
        self.step <= 20
            && self.actions <= 20
            && self.action.chars().count() <= 80
            && self
                .app
                .as_ref()
                .is_none_or(|app| app.chars().count() <= 256)
            && self.cursor.as_ref().is_none_or(ComputerCursor::valid)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub enum OverlayAction {
    SetMessage(SharedString),
    Submit(SharedString),
    DismissOverlay,
    StartDrawing,
    ToggleDictation,
    CaptureScreen,
    SaveScreen,
    ClearAnnotation(SharedString),
    OpenOverlay,
    OpenWorkspace(Option<SharedString>),
    MigrateToWorkspace,
    ToggleModels,
    PickModel(SharedString),
    ToggleModes,
    PickMode(PermissionMode),
    NavigateSlash(i32),
    PickSlash(SharedString),
    PickSource(SharedString),
    DismissSlash,
    RunCommand(SharedString),
    Choice(SharedString),
    BeginPillDrag(GeometryPoint),
    MovePill(GeometryPoint),
    EndPillDrag,
    ExpandPill,
    DismissPill,
    SelectOrb(SharedString),
    AnnotationBegin(AnnotationPoint),
    AnnotationDraw(AnnotationPoint),
    AnnotationEnd,
    FinishAnnotation,
    CancelAnnotation,
    StopComputerRun,
}

#[derive(Clone, Debug, PartialEq)]
pub struct SlashItem {
    pub id: SharedString,
    pub name: SharedString,
    pub kind: SharedString,
    pub detail: SharedString,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OrbCommand {
    pub id: SharedString,
    pub label: SharedString,
    pub glyph: SharedString,
    pub disabled: bool,
}

#[derive(Clone, Debug, PartialEq)]
pub struct OverlayState {
    pub surface: OverlaySurface,
    pub notch: NotchPlacement,
    pub grow: f32,
    pub message: SharedString,
    pub busy: bool,
    pub error: Option<SharedString>,
    pub dictation_error: Option<SharedString>,
    pub listening: bool,
    pub transcribing: bool,
    pub turns: Vec<OverlayTurn>,
    pub stream: OverlayStream,
    pub annotation: Option<AnnotationAttachment>,
    pub model: OverlayModel,
    pub model_options: Vec<OverlayModel>,
    pub mode: PermissionMode,
    pub models_open: bool,
    pub modes_open: bool,
    pub slash_open: bool,
    pub slash_query: Option<SharedString>,
    pub slash_matches: Vec<SlashItem>,
    pub slash_active: usize,
    pub source_menu_open: bool,
    pub source_items: Vec<SlashItem>,
    pub commands_open: bool,
    pub commands: Vec<OrbCommand>,
    pub context_tokens: Option<u32>,
    pub rate: Option<u32>,
    pub reduced_motion: bool,
    pub pill_status: PillStatus,
    pub pill_label: SharedString,
    pub pill_leaving: bool,
}

impl Default for OverlayState {
    fn default() -> Self {
        Self {
            surface: OverlaySurface::Notch,
            notch: NotchPlacement {
                left: 0.,
                width: 180.,
                height: 32.,
            },
            grow: 0.,
            message: SharedString::new_static(""),
            busy: false,
            error: None,
            dictation_error: None,
            listening: false,
            transcribing: false,
            turns: Vec::new(),
            stream: OverlayStream::default(),
            annotation: None,
            model: OverlayModel::default(),
            model_options: Vec::new(),
            mode: PermissionMode::Ask,
            models_open: false,
            modes_open: false,
            slash_open: false,
            slash_query: None,
            slash_matches: Vec::new(),
            slash_active: 0,
            source_menu_open: false,
            source_items: Vec::new(),
            commands_open: false,
            commands: Vec::new(),
            context_tokens: None,
            rate: None,
            reduced_motion: false,
            pill_status: PillStatus::Working,
            pill_label: SharedString::new_static("Working"),
            pill_leaving: false,
        }
    }
}

fn emit(
    callback: &Option<OverlayCallback>,
    action: OverlayAction,
    window: &mut Window,
    cx: &mut App,
) {
    if let Some(callback) = callback {
        callback(action, window, cx);
    }
}

fn control_button(
    id: impl Into<ElementId>,
    label: impl Into<SharedString>,
    action: OverlayAction,
    disabled: bool,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> Button {
    let label = label.into();
    let mut button = Button::new(id)
        .ghost()
        .small()
        .rounded(theme.radii.none)
        .disabled(disabled)
        .label(label.clone())
        .accessibility_label(label)
        .text_color(theme.colors.text_2);
    if let Some(callback) = callback.clone() {
        button = button.on_click(move |_, window, cx| callback(action.clone(), window, cx));
    }
    button
}

#[derive(IntoElement)]
pub struct QuickAskOverlay {
    state: OverlayState,
    composer: Option<Entity<TextareaState>>,
    focus: Option<FocusHandle>,
    callback: Option<OverlayCallback>,
}

impl QuickAskOverlay {
    pub fn new(state: OverlayState) -> Self {
        Self {
            state,
            composer: None,
            focus: None,
            callback: None,
        }
    }

    pub fn composer(mut self, composer: Entity<TextareaState>) -> Self {
        self.composer = Some(composer);
        self
    }

    pub fn focus_handle(mut self, focus: FocusHandle) -> Self {
        self.focus = Some(focus);
        self
    }

    pub fn on_action(
        mut self,
        callback: impl Fn(OverlayAction, &mut Window, &mut App) + 'static,
    ) -> Self {
        self.callback = Some(Rc::new(callback));
        self
    }
}

impl RenderOnce for QuickAskOverlay {
    fn render(self, window: &mut Window, cx: &mut App) -> impl IntoElement {
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let focus = self.focus.unwrap_or_else(|| cx.focus_handle());
        let state = self.state;
        let callback = self.callback;
        let composer = self.composer;
        let key_callback = callback.clone();
        let key_message = state.message.clone();
        let slash_open = state.slash_open;
        let slash_active = state.slash_active;
        let slash_matches = state.slash_matches.clone();
        let mut root = div()
            .id("quick-ask-surface")
            .relative()
            .size_full()
            .track_focus(&focus)
            .bg(transparent_black())
            .text_color(theme.colors.text)
            .font_family(theme.typography.font.clone())
            .text_size(theme.typography.fs_md)
            .line_height(relative(theme.typography.line_height))
            .on_key_down(move |event, window, cx| {
                if event.keystroke.key.as_str() == "escape" {
                    emit(&key_callback, OverlayAction::DismissSlash, window, cx);
                    if !slash_open {
                        emit(&key_callback, OverlayAction::DismissOverlay, window, cx);
                    }
                } else if slash_open {
                    match event.keystroke.key.as_str() {
                        "up" => {
                            emit(&key_callback, OverlayAction::NavigateSlash(-1), window, cx);
                        }
                        "down" => {
                            emit(&key_callback, OverlayAction::NavigateSlash(1), window, cx);
                        }
                        "enter" | "tab" => {
                            if let Some(item) = slash_matches.get(slash_active) {
                                emit(
                                    &key_callback,
                                    OverlayAction::PickSlash(item.name.clone()),
                                    window,
                                    cx,
                                );
                            }
                        }
                        _ => {}
                    }
                } else if event.keystroke.key.as_str() == "enter"
                    && !event.keystroke.modifiers.shift
                {
                    emit(
                        &key_callback,
                        OverlayAction::Submit(key_message.clone()),
                        window,
                        cx,
                    );
                }
            });
        match state.surface {
            OverlaySurface::Pill => {
                root = root.child(render_status_pill(&state, &callback, &theme))
            }
            OverlaySurface::Notch | OverlaySurface::Popout => {
                root = root.child(render_island(state, composer, callback, &theme, window));
            }
        }
        root
    }
}

fn render_island(
    state: OverlayState,
    composer: Option<Entity<TextareaState>>,
    callback: Option<OverlayCallback>,
    theme: &EmmaTheme,
    _window: &mut Window,
) -> AnyElement {
    let detached = state.surface == OverlaySurface::Popout;
    let chrome_height = if detached {
        POPOUT_BAR
    } else {
        state.notch.height.max(8.)
    };
    let island_height = if detached {
        POPOUT_BAR + ISLAND_HEIGHT + overlay_growth(state.grow)
    } else {
        state.notch.height.max(8.) + ISLAND_HEIGHT + overlay_growth(state.grow)
    };
    let colors = theme.colors;
    let spacing = theme.spacing;
    let mut island = v_flex()
        .id("quick-ask-island")
        .relative()
        .h(px(island_height))
        .mx(theme.dimensions.island_inset)
        .bg(colors.bg)
        .border_1()
        .border_color(colors.border_strong)
        .shadow(vec![theme.shadows.lg.box_shadow()])
        .overflow_hidden();
    if detached {
        island = island.border_t_1();
    }
    island = island.child(render_island_bar(&state, chrome_height, detached, theme));
    let mut body = v_flex()
        .id("island-body")
        .flex_1()
        .min_h_0()
        .justify_center()
        .gap(spacing.s2)
        .overflow_hidden()
        .px(spacing.s4)
        .py(spacing.s3);
    if state.commands_open {
        body = body.opacity(0.3);
    }
    if let Some(attachment) = state.annotation.clone() {
        body = body.child(render_annotation_chip(attachment, &callback, theme));
    }
    let mut form = h_flex()
        .id("island-composer")
        .items_center()
        .gap(spacing.s3);
    if let Some(composer) = composer {
        form = form.child(
            Textarea::new(&composer)
                .appearance(false)
                .bordered(false)
                .disabled(state.busy)
                .min_h(px(24.))
                .h(px(28.))
                .flex_1()
                .aria_label("Ask Emma")
                .font_family(theme.typography.font.clone())
                .text_size(theme.typography.fs_md)
                .text_color(colors.text),
        );
    } else {
        form = form.child(
            div()
                .id("island-message-placeholder")
                .flex_1()
                .text_color(if state.message.is_empty() {
                    colors.text_3
                } else {
                    colors.text
                })
                .child(if state.message.is_empty() {
                    "Ask Emma anything…".into()
                } else {
                    state.message.clone()
                }),
        );
    }
    let action_callback = callback.clone();
    form = form.child(
        h_flex()
            .id("overlay-actions")
            .items_center()
            .gap(spacing.s1)
            .child(control_button(
                "overlay-draw",
                "✎",
                OverlayAction::StartDrawing,
                state.busy,
                &action_callback,
                theme,
            ))
            .child(control_button(
                "overlay-voice",
                if state.listening { "●" } else { "○" },
                OverlayAction::ToggleDictation,
                state.busy || state.transcribing,
                &action_callback,
                theme,
            ))
            .child(render_send_button(
                state.busy,
                state.message.trim().is_empty(),
                state.message.clone(),
                &action_callback,
                theme,
            )),
    );
    body = body.child(form);
    if let Some(error) = state.error.clone().or(state.dictation_error.clone()) {
        body = body.child(
            control_button(
                "overlay-error",
                format!("{} ×", error),
                OverlayAction::SetMessage(SharedString::new_static("")),
                false,
                &callback,
                theme,
            )
            .text_color(colors.danger),
        );
    }
    let has_transcript = state.busy || !state.turns.is_empty();
    let transcript = render_transcript(&state, &callback, theme);
    let footer = render_island_footer(&state, &callback, theme);
    if has_transcript {
        island = island.child(transcript);
    }
    island = island.child(body);
    if state.slash_open {
        island = island.child(render_slash_menu(&state, &callback, theme));
    }
    if state.source_menu_open {
        island = island.child(render_source_menu(&state, &callback, theme));
    }
    island = island.child(footer);
    if state.models_open {
        island = island.child(render_model_menu(&state, &callback, theme));
    }
    if state.modes_open {
        island = island.child(render_mode_menu(&state, &callback, theme));
    }
    let mut root = div()
        .id("overlay-island-root")
        .relative()
        .size_full()
        .child(island);
    if state.commands_open {
        root = root.child(render_command_orbs(&state, &callback, theme));
    }
    root.into_any_element()
}

fn render_island_bar(
    state: &OverlayState,
    height: f32,
    detached: bool,
    theme: &EmmaTheme,
) -> AnyElement {
    let colors = theme.colors;
    let spacing = theme.spacing;
    let brand = h_flex()
        .id("island-brand")
        .items_center()
        .gap(spacing.s3)
        .px(spacing.s4)
        .child(emma_logo(theme, px(22.)))
        .child(
            div()
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_md)
                .text_color(colors.text)
                .child("Emma"),
        );
    let status_text = if state.listening {
        "Listening"
    } else if state.transcribing {
        "Transcribing"
    } else if state.busy {
        "Working"
    } else {
        "Quick thread"
    };
    let status = h_flex()
        .id("island-status")
        .items_center()
        .justify_end()
        .gap(spacing.s2)
        .min_w_0()
        .flex_1()
        .px(spacing.s4)
        .text_color(colors.text_3)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .child(
            div()
                .w(px(4.))
                .h(px(4.))
                .rounded(px(999.))
                .bg(colors.accent),
        )
        .child(status_text);
    let mut bar = h_flex()
        .id("island-bar")
        .flex_none()
        .h(px(height))
        .w_full()
        .border_b_1()
        .border_color(colors.border)
        .items_center();
    if detached {
        bar = bar.child(brand).child(status);
    } else {
        let left_width = (state.notch.left - ISLAND_INSET).max(0.);
        bar = bar
            .child(div().h_full().w(px(left_width)).child(brand))
            .child(div().h_full().w(px(state.notch.width.max(0.))))
            .child(status);
    }
    bar.into_any_element()
}

fn emma_logo(theme: &EmmaTheme, edge: gpui::Pixels) -> AnyElement {
    gpui::img("desktop/assets/emma.webp")
        .id("emma-logo")
        .w(edge)
        .h(edge)
        .text_color(theme.colors.text)
        .into_any_element()
}

fn render_annotation_chip(
    attachment: AnnotationAttachment,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let attachment_label = attachment.source_application.clone().map_or_else(
        || "Screen capture".to_owned(),
        |app| format!("Screen capture of {app}"),
    );
    let mut chip = h_flex()
        .id("annotation-chip")
        .relative()
        .w(px(84.))
        .h(px(52.))
        .border_1()
        .border_color(theme.colors.border)
        .bg(theme.colors.surface_2)
        .role(gpui::accesskit::Role::Image)
        .aria_label(attachment_label);
    if let Some(image) = attachment.image {
        chip = chip.child(gpui::img(image).w(px(84.)).h(px(52.)));
    } else {
        chip = chip.child(
            div()
                .w_full()
                .h_full()
                .items_center()
                .justify_center()
                .text_color(theme.colors.text_3)
                .text_size(theme.typography.fs_2xs)
                .child("Screen"),
        );
    }
    chip = chip.child(
        control_button(
            "annotation-discard",
            "×",
            OverlayAction::ClearAnnotation(attachment.id),
            false,
            callback,
            theme,
        )
        .absolute()
        .top_0()
        .right_0()
        .w(px(16.))
        .h(px(16.))
        .px(px(0.)),
    );
    chip.into_any_element()
}

fn render_transcript(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut transcript = v_flex()
        .id("island-thread")
        .w_full()
        .flex_none()
        .max_h(theme.dimensions.island_transcript_max_height)
        .px(theme.spacing.s4)
        .pb(theme.spacing.s3)
        .overflow_y_scrollbar();
    if state.busy || !state.turns.is_empty() {
        transcript = transcript
            .flex_1()
            .min_h_0()
            .pt(theme.spacing.s3)
            .border_b_1()
            .border_color(theme.colors.border);
    }
    for (index, turn) in state.turns.iter().enumerate() {
        transcript = transcript.child(render_turn(turn, index, callback, theme));
    }
    if state.busy {
        let stream_text: SharedString = if state.stream.text.is_empty() {
            "···".into()
        } else {
            state.stream.text.clone()
        };
        transcript = transcript.child(render_turn(
            &OverlayTurn::assistant(stream_text).steps(state.stream.steps.clone()),
            state.turns.len(),
            callback,
            theme,
        ));
    }
    if state.turns.len() >= 6 {
        transcript = transcript.child(control_button(
            "island-migrate",
            "Getting long — continue in the full app →",
            OverlayAction::MigrateToWorkspace,
            false,
            callback,
            theme,
        ));
    }
    transcript.into_any_element()
}

fn render_turn(
    turn: &OverlayTurn,
    index: usize,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let colors = theme.colors;
    let mut row = v_flex()
        .id(format!("island-turn-{index}"))
        .w_full()
        .gap(theme.spacing.s1)
        .py(theme.spacing.s2)
        .text_color(if turn.role == OverlayRole::User {
            colors.text_2
        } else {
            colors.text
        })
        .text_size(theme.typography.fs_sm)
        .line_height(relative(1.5));
    if index > 0 {
        row = row.border_t_1().border_color(colors.border);
    }
    let role = match turn.role {
        OverlayRole::User => "You",
        OverlayRole::Assistant => "Emma",
    };
    row = row.child(
        h_flex()
            .id(format!("island-turn-label-{index}"))
            .gap(theme.spacing.s2)
            .text_color(colors.text_3)
            .font_family(theme.typography.font_mono.clone())
            .text_size(theme.typography.fs_2xs)
            .child(role)
            .child(div().flex_1().h(px(1.)).bg(transparent_black())),
    );
    row = row.child(
        div()
            .id(format!("island-turn-content-{index}"))
            .child(turn.content.clone()),
    );
    if !turn.steps.is_empty() {
        row = row.child(render_steps(&turn.steps, theme));
    }
    if !turn.choices.is_empty() {
        let mut choices = h_flex()
            .id(format!("turn-choices-{index}"))
            .gap(theme.spacing.s2)
            .w_full();
        for (choice_index, choice) in turn.choices.iter().enumerate() {
            choices = choices.child(control_button(
                format!("turn-choice-{index}-{choice_index}"),
                choice.label.clone(),
                choice.action.clone(),
                false,
                callback,
                theme,
            ));
        }
        row = row.child(choices);
    }
    row.into_any_element()
}

fn render_steps(steps: &[OverlayStep], theme: &EmmaTheme) -> AnyElement {
    let mut list = v_flex()
        .id(format!("overlay-steps-{}", steps.len()))
        .gap(theme.spacing.s1)
        .px(theme.spacing.s4)
        .text_color(theme.colors.text_3)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs);
    for (index, step) in steps.iter().enumerate() {
        let marker = match step.status.as_ref() {
            "completed" => "✓",
            "failed" => "!",
            "cancelled" => "×",
            "in_progress" | "pending" => "·",
            _ => "·",
        };
        list = list.child(
            h_flex()
                .id(format!("overlay-step-{index}-{}", step.id))
                .gap(theme.spacing.s2)
                .child(div().text_color(theme.colors.accent).child(marker))
                .child(if step.title.is_empty() {
                    step.kind.clone()
                } else {
                    step.title.clone()
                }),
        );
    }
    list.into_any_element()
}

fn render_slash_menu(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let label = if state
        .slash_query
        .as_ref()
        .is_some_and(|query| query.starts_with('@'))
    {
        "Artifacts, saved notes and files"
    } else {
        "Built-in tools, skills and MCP servers"
    };
    let mut menu = v_flex()
        .id("island-slash-menu")
        .w_full()
        .max_h(px(170.))
        .py(theme.spacing.s1)
        .border_t_1()
        .border_color(theme.colors.border)
        .role(gpui::accesskit::Role::ListBox)
        .aria_label(label)
        .overflow_y_scrollbar();
    if state.slash_matches.is_empty() {
        let detail = if label.starts_with("Artifacts") {
            "Artifacts, saved notes and the files of granted folders appear here."
        } else {
            "Built-in tools, imported skills and MCP servers appear here."
        };
        menu = menu.child(
            div()
                .id("slash-empty")
                .px(theme.spacing.s4)
                .py(theme.spacing.s2)
                .text_color(theme.colors.text_3)
                .text_size(theme.typography.fs_sm)
                .child(format!(
                    "Nothing matches “{}”. {}",
                    state.slash_query.clone().unwrap_or_default(),
                    detail
                )),
        );
    }
    for (index, item) in state.slash_matches.iter().enumerate() {
        let active = index == state.slash_active;
        let mut row = Button::new(format!("slash-row-{}-{}", item.kind, item.id))
            .ghost()
            .small()
            .rounded(theme.radii.none)
            .w_full()
            .justify_start()
            .gap(theme.spacing.s2)
            .selected(active)
            .role(gpui::accesskit::Role::ListBoxOption)
            .accessibility_label(format!("{} {}", item.name, item.detail));
        row = row.child(
            h_flex()
                .w_full()
                .items_center()
                .gap(theme.spacing.s2)
                .child(
                    div()
                        .font_family(theme.typography.font_mono.clone())
                        .text_color(theme.colors.text)
                        .child(format!(
                            "{}{}",
                            if state
                                .slash_query
                                .as_ref()
                                .is_some_and(|query| query.starts_with('@'))
                            {
                                "@"
                            } else {
                                "/"
                            },
                            item.name
                        )),
                )
                .child(
                    div()
                        .text_color(theme.colors.accent)
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_2xs)
                        .child(item.kind.clone()),
                )
                .child(
                    div()
                        .flex_1()
                        .truncate()
                        .text_color(theme.colors.text_3)
                        .text_size(theme.typography.fs_2xs)
                        .child(item.detail.clone()),
                ),
        );
        if let Some(callback) = callback.clone() {
            let name = item.name.clone();
            row = row.on_click(move |_, window, cx| {
                callback(OverlayAction::PickSlash(name.clone()), window, cx);
            });
        }
        menu = menu.child(row);
    }
    menu.into_any_element()
}

fn render_source_menu(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut menu = v_flex()
        .id("island-source-menu")
        .w_full()
        .max_h(px(190.))
        .border_t_1()
        .border_color(theme.colors.border)
        .role(gpui::accesskit::Role::Menu)
        .aria_label("Add context or plugin")
        .overflow_y_scrollbar();
    for (index, item) in state.source_items.iter().enumerate() {
        let mut row = Button::new(format!("source-row-{index}-{}", item.id))
            .ghost()
            .small()
            .rounded(theme.radii.none)
            .w_full()
            .justify_start()
            .child(
                h_flex()
                    .w_full()
                    .gap(theme.spacing.s2)
                    .child(item.name.clone())
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_color(theme.colors.text_3)
                            .text_size(theme.typography.fs_2xs)
                            .child(item.detail.clone()),
                    ),
            )
            .accessibility_label(format!("{} {}", item.name, item.detail));
        if let Some(callback) = callback.clone() {
            let id = item.id.clone();
            row = row.on_click(move |_, window, cx| {
                callback(OverlayAction::PickSource(id.clone()), window, cx);
            });
        }
        menu = menu.child(row);
    }
    menu.into_any_element()
}

fn render_model_menu(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut menu = v_flex()
        .id("island-model-menu")
        .w_full()
        .max_h(px(240.))
        .border_t_1()
        .border_color(theme.colors.border)
        .role(gpui::accesskit::Role::Menu)
        .aria_label("Model")
        .overflow_y_scrollbar();
    let options = if state.model_options.is_empty() {
        vec![state.model.clone()]
    } else {
        state.model_options.clone()
    };
    for (index, model) in options.into_iter().enumerate() {
        let active = model.key == state.model.key;
        let route = model.route.clone().unwrap_or_default();
        let mut row = Button::new(format!("model-row-{index}"))
            .ghost()
            .small()
            .rounded(theme.radii.none)
            .w_full()
            .justify_start()
            .selected(active)
            .accessibility_label(format!("Select model {}", model.label))
            .child(
                h_flex()
                    .w_full()
                    .items_center()
                    .gap(theme.spacing.s2)
                    .child(
                        div()
                            .w(px(16.))
                            .h(px(16.))
                            .items_center()
                            .justify_center()
                            .text_color(theme.colors.text_3)
                            .font_family(theme.typography.font_mono.clone())
                            .text_size(theme.typography.fs_2xs)
                            .child(model.brand.clone().unwrap_or_else(|| {
                                model.label.chars().next().unwrap_or('M').to_string().into()
                            })),
                    )
                    .child(
                        div()
                            .flex_1()
                            .truncate()
                            .text_color(theme.colors.text)
                            .child(model.label.clone()),
                    )
                    .child(
                        div()
                            .text_color(if active {
                                theme.colors.accent
                            } else {
                                theme.colors.text_3
                            })
                            .font_family(theme.typography.font_mono.clone())
                            .text_size(theme.typography.fs_2xs)
                            .child(route),
                    ),
            );
        if let Some(callback) = callback.clone() {
            let key = model.key.clone();
            row = row.on_click(move |_, window, cx| {
                callback(OverlayAction::PickModel(key.clone()), window, cx);
            });
        }
        menu = menu.child(row);
    }
    menu.into_any_element()
}

fn render_mode_menu(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut menu = v_flex()
        .id("island-mode-menu")
        .w_full()
        .max_h(px(190.))
        .border_t_1()
        .border_color(theme.colors.border)
        .role(gpui::accesskit::Role::ListBox)
        .aria_label("Permission mode")
        .overflow_y_scrollbar();
    for (index, mode) in PermissionMode::ALL.into_iter().enumerate() {
        let active = mode == state.mode;
        let mut row = Button::new(format!("mode-row-{}", mode.id()))
            .ghost()
            .small()
            .rounded(theme.radii.none)
            .w_full()
            .justify_start()
            .selected(active)
            .role(gpui::accesskit::Role::ListBoxOption)
            .accessibility_label(format!("Permission mode {}", mode.label()))
            .child(
                h_flex()
                    .id(format!("mode-row-content-{index}"))
                    .w_full()
                    .items_start()
                    .gap(theme.spacing.s2)
                    .child(
                        div()
                            .text_color(mode_color(mode, theme))
                            .font_family(theme.typography.font_mono.clone())
                            .child(mode.glyph()),
                    )
                    .child(
                        v_flex()
                            .gap(theme.spacing.s1)
                            .child(div().text_color(theme.colors.text).child(mode.label()))
                            .child(
                                div()
                                    .text_color(theme.colors.text_3)
                                    .text_size(theme.typography.fs_2xs)
                                    .child(mode.hint()),
                            ),
                    )
                    .when(active, |this| {
                        this.child(
                            div()
                                .ml_auto()
                                .text_color(theme.colors.accent)
                                .font_family(theme.typography.font_mono.clone())
                                .text_size(theme.typography.fs_2xs)
                                .child("Active"),
                        )
                    }),
            );
        if let Some(callback) = callback.clone() {
            row = row.on_click(move |_, window, cx| {
                callback(OverlayAction::PickMode(mode), window, cx);
            });
        }
        menu = menu.child(row);
    }
    menu.into_any_element()
}

fn mode_color(mode: PermissionMode, theme: &EmmaTheme) -> Hsla {
    match mode {
        PermissionMode::Ask => theme.colors.blue,
        PermissionMode::AcceptEdits => theme.colors.lime,
        PermissionMode::Auto => theme.colors.violet,
        PermissionMode::Full => theme.colors.accent,
    }
}

fn render_island_footer(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let spacing = theme.spacing;
    let mut footer = h_flex()
        .id("island-foot")
        .flex_none()
        .items_center()
        .gap(spacing.s3)
        .min_h(px(26.))
        .px(spacing.s2)
        .border_t_1()
        .border_color(theme.colors.border)
        .font_family(theme.typography.font_mono.clone())
        .text_size(theme.typography.fs_2xs)
        .text_color(theme.colors.text_3);
    footer = footer.child(
        control_button(
            "mode-trigger",
            format!("{} {} ▾", state.mode.glyph(), state.mode.label()),
            OverlayAction::ToggleModes,
            state.busy,
            callback,
            theme,
        )
        .text_color(theme.colors.text_2),
    );
    let mut model_button = control_button(
        "model-button",
        format!(
            "{}{}{} ▾",
            state.model.label,
            state
                .model
                .route
                .as_ref()
                .map_or_else(String::new, |route| format!(" · {route}")),
            state
                .model
                .thinking
                .as_ref()
                .map_or_else(String::new, |thinking| format!(" · {thinking}")),
        ),
        OverlayAction::ToggleModels,
        state.busy,
        callback,
        theme,
    );
    model_button = model_button.flex_1().justify_start().min_w_0();
    footer = footer.child(model_button);
    footer = footer.child(
        h_flex()
            .id("island-stats")
            .items_center()
            .gap(spacing.s3)
            .child(if let Some(tokens) = state.context_tokens {
                format!("{}K ctx", tokens / 1000)
            } else {
                "— ctx".to_string()
            })
            .child(if let Some(rate) = state.rate {
                format!("{rate} tok/s")
            } else {
                "— tok/s".to_string()
            }),
    );
    footer.into_any_element()
}

fn render_command_orbs(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let mut row = h_flex()
        .id("command-orbs")
        .absolute()
        .top(px(state.notch.height
            + ISLAND_HEIGHT
            + overlay_growth(state.grow)
            + 16.))
        .left(px(
            state.notch.left + state.notch.width * 0.5 - ISLAND_WIDTH * 0.5
        ))
        .gap(theme.spacing.s7)
        .w(px(ISLAND_WIDTH))
        .justify_center()
        .items_start();
    for (index, command) in state.commands.iter().take(8).enumerate() {
        let mut button = Button::new(format!("command-orb-{index}"))
            .ghost()
            .small()
            .rounded(theme.radii.none)
            .w(px(96.))
            .flex_none()
            .gap(theme.spacing.s2)
            .items_center()
            .child(
                div()
                    .id(format!("command-orb-glyph-{index}"))
                    .w(px(40.))
                    .h(px(40.))
                    .items_center()
                    .justify_center()
                    .border_1()
                    .border_color(theme.colors.border_strong)
                    .bg(theme.colors.bg)
                    .shadow(vec![theme.shadows.sm.box_shadow()])
                    .text_color(orb_color(index, theme))
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_sm)
                    .child(command.glyph.clone()),
            )
            .child(
                div()
                    .w(px(96.))
                    .text_color(theme.colors.text_2)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_2xs)
                    .child(command.label.clone()),
            )
            .disabled(command.disabled)
            .accessibility_label(command.label.clone());
        if let Some(callback) = callback.clone() {
            let id = command.id.clone();
            button = button.on_click(move |_, window, cx| {
                callback(OverlayAction::RunCommand(id.clone()), window, cx);
            });
        }
        row = row.child(button);
    }
    row.into_any_element()
}

fn orb_color(index: usize, theme: &EmmaTheme) -> Hsla {
    match index % 5 {
        0 => theme.colors.teal,
        1 => theme.colors.violet,
        2 => theme.colors.lime,
        3 => theme.colors.blue,
        _ => theme.colors.rose,
    }
}

fn render_send_button(
    busy: bool,
    empty: bool,
    message: SharedString,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> Button {
    let mut button = Button::new("overlay-send")
        .ghost()
        .small()
        .rounded(theme.radii.none)
        .w(px(26.))
        .h(px(26.))
        .items_center()
        .justify_center()
        .disabled(busy || empty)
        .accessibility_label("Send")
        .text_color(if busy || empty {
            theme.colors.text_3
        } else {
            theme.colors.accent
        });
    if busy {
        button = button.child("···");
    } else {
        button = button.child(render_send_icon(theme.colors.accent));
    }
    if let Some(callback) = callback.clone() {
        button = button.on_click(move |_, window, cx| {
            callback(OverlayAction::Submit(message.clone()), window, cx);
        });
    }
    button
}

fn render_send_icon(color: Hsla) -> AnyElement {
    canvas(
        move |_, _, _| color,
        move |area, color, window, _| {
            let origin = area.origin;
            let point_at = |x: f32, y: f32| point(origin.x + px(x), origin.y + px(y));
            let mut outline = PathBuilder::stroke(px(1.4));
            outline.move_to(point_at(14.5, 1.5));
            outline.line_to(point_at(1.8, 6.3));
            outline.line_to(point_at(6.9, 8.3));
            outline.line_to(point_at(8.9, 13.4));
            outline.close();
            outline.move_to(point_at(14.5, 1.5));
            outline.line_to(point_at(6.9, 8.3));
            if let Ok(path) = outline.build() {
                window.paint_path(path, color);
            }
        },
    )
    .w(px(15.))
    .h(px(15.))
    .into_any_element()
}

fn render_mark(color: Hsla, reduced_motion: bool) -> AnyElement {
    const BOW: [&str; 11] = [
        ".####......####.",
        ".######..######.",
        ".##..##oo##..##.",
        ".##..##oo##..##.",
        ".##..##oo##..##.",
        ".######oo######.",
        ".####..oo..####.",
        "......####......",
        ".....##..##.....",
        "....###..###....",
        "....##....##....",
    ];
    let edge = if reduced_motion { 18. } else { 20. };
    canvas(
        move |_, _, _| color,
        move |area, color, window, _| {
            let cell = edge / 16.;
            let origin = area.origin;
            for (row_index, row) in BOW.iter().enumerate() {
                for (column, ink) in row.chars().enumerate() {
                    if ink == '.' {
                        continue;
                    }
                    let pixel = bounds(
                        point(
                            origin.x + px(column as f32 * cell),
                            origin.y + px((row_index as f32 + 3.) * cell),
                        ),
                        size(px(cell), px(cell)),
                    );
                    window.paint_quad(fill(
                        pixel,
                        if ink == 'o' { color.alpha(0.5) } else { color },
                    ));
                }
            }
        },
    )
    .w(px(edge))
    .h(px(edge))
    .into_any_element()
}

fn render_status_pill(
    state: &OverlayState,
    callback: &Option<OverlayCallback>,
    theme: &EmmaTheme,
) -> AnyElement {
    let color = match state.pill_status {
        PillStatus::Working => theme.colors.yellow,
        PillStatus::Error => theme.colors.orange,
        PillStatus::Done => theme.colors.lime,
    };
    let begin_callback = callback.clone();
    let move_callback = callback.clone();
    let end_callback = callback.clone();
    let key_callback = callback.clone();
    let up_expand_callback = callback.clone();
    let drag_state = Rc::new(RefCell::new(None::<(GeometryPoint, bool)>));
    let down_state = drag_state.clone();
    let move_state = drag_state.clone();
    let up_state = drag_state;
    let pill = div()
        .id("status-pill")
        .absolute()
        .top_0()
        .left_0()
        .w(px(PILL_SIZE))
        .h(px(PILL_SIZE))
        .items_center()
        .justify_center()
        .bg(theme.colors.bg)
        .border_1()
        .border_color(color)
        .shadow(vec![theme.shadows.lg.box_shadow()])
        .opacity(if state.pill_leaving { 0. } else { 1. })
        .role(gpui::accesskit::Role::Button)
        .aria_label(format!(
            "Emma — {}. Open the quick thread here",
            state.pill_label
        ))
        .tab_index(0)
        .on_mouse_down(MouseButton::Left, move |event, window, cx| {
            let point = GeometryPoint {
                x: event.position.x.into(),
                y: event.position.y.into(),
            };
            *down_state.borrow_mut() = Some((point, false));
            emit(
                &begin_callback,
                OverlayAction::BeginPillDrag(point),
                window,
                cx,
            );
        })
        .on_mouse_move(move |event, window, cx| {
            let point = GeometryPoint {
                x: event.position.x.into(),
                y: event.position.y.into(),
            };
            let mut state = move_state.borrow_mut();
            let Some((origin, moved)) = state.as_mut() else {
                return;
            };
            if !*moved && (point.x - origin.x).abs() + (point.y - origin.y).abs() < 3. {
                return;
            }
            *moved = true;
            emit(&move_callback, OverlayAction::MovePill(point), window, cx);
        })
        .on_mouse_up(MouseButton::Left, move |_, window, cx| {
            let moved = up_state.take().is_none_or(|(_, moved)| moved);
            emit(&end_callback, OverlayAction::EndPillDrag, window, cx);
            if !moved {
                emit(&up_expand_callback, OverlayAction::ExpandPill, window, cx);
            }
        })
        .on_key_down(move |event, window, cx| {
            if matches!(event.keystroke.key.as_str(), "enter" | "space") {
                emit(&key_callback, OverlayAction::ExpandPill, window, cx);
            }
        })
        .child(render_mark(color, state.reduced_motion));
    pill.into_any_element()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn display() -> DisplayGeometry {
        DisplayGeometry {
            bounds: SurfaceRect::new(0., 0., 1380., 860.),
            work_area: SurfaceRect::new(0., 24., 1380., 836.),
        }
    }

    fn notch() -> NotchGeometry {
        NotchGeometry {
            id: 7.,
            x: 600.,
            width: 180.,
            height: 32.,
        }
    }

    fn close(left: f32, right: f32) {
        assert!((left - right).abs() < 0.001, "{left} != {right}");
    }

    #[test]
    fn geometry_matches_desktop_defaults() {
        let layout = overlay_layout(display(), 180., Some(notch()));
        assert_eq!(layout.bounds, SurfaceRect::new(380., 0., 620., 255.));
        assert_eq!(
            layout.notch,
            NotchPlacement {
                left: 220.,
                width: 180.,
                height: 32.,
            }
        );
        assert_eq!(
            pill_layout(display(), None),
            SurfaceRect::new(1320., 40., 44., 44.)
        );
        let popout = popout_layout(display(), GeometryPoint { x: 1320., y: 40. }, 999.);
        assert_eq!(popout.base, 125.);
        assert_eq!(popout.bounds, SurfaceRect::new(760., 40., 620., 385.));
        assert_eq!(
            hotspot_layout(display(), notch()).bounds,
            SurfaceRect::new(586., 0., 208., 76.)
        );
        assert_eq!(
            radial_window_layout(display(), GeometryPoint { x: 1379., y: 859. }),
            SurfaceRect::new(1120., 600., 260., 260.)
        );
    }

    #[test]
    fn geometry_clamps_user_positions() {
        assert_eq!(
            pill_layout(display(), Some(GeometryPoint { x: -100., y: 9999. })),
            SurfaceRect::new(0., 816., 44., 44.)
        );
        let popout = popout_layout(display(), GeometryPoint { x: -80., y: -80. }, -20.);
        assert_eq!(popout.bounds, SurfaceRect::new(0., 24., 620., 125.));
        assert!(near_bounds(
            SurfaceRect::new(10., 10., 20., 20.),
            GeometryPoint { x: 0., y: 20. },
            10.
        ));
        assert!(!near_bounds(
            SurfaceRect::new(10., 10., 20., 20.),
            GeometryPoint { x: -1., y: 20. },
            10.
        ));
        close(overlay_growth(f32::NAN), 0.);
        close(overlay_growth(-20.), 0.);
        close(overlay_growth(999.), 260.);
        close(overlay_growth(12.4), 12.);
    }

    #[test]
    fn notch_geometry_validation_matches_native_contract() {
        let parsed = parse_notch_geometry(r#"[{"id":7.5,"x":600.4,"width":180.4,"height":31.6}]"#)
            .expect("valid notch geometry");
        assert_eq!(
            parsed,
            vec![NotchGeometry {
                id: 7.5,
                x: 600.,
                width: 180.,
                height: 32.,
            }]
        );
        for value in [
            "{}",
            "[{\"id\":\"7\",\"x\":600,\"width\":180,\"height\":32}]",
            "[{\"id\":7,\"x\":600,\"width\":20,\"height\":32}]",
            "[{\"id\":7,\"x\":600,\"width\":180,\"height\":121}]",
        ] {
            assert!(parse_notch_geometry(value).is_err(), "{value}");
        }
        let too_many = serde_json::to_string(&vec![
            serde_json::json!({"id": 1, "x": 0, "width": 40, "height": 8});
            17
        ])
        .expect("json");
        assert!(parse_notch_geometry(&too_many).is_err());
    }

    #[test]
    fn notch_wave_and_timing_contract_is_stable() {
        let rows = wave_rows(60., false, 0);
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().all(|row| row.chars().count() == 12));
        assert_ne!(rows, wave_rows(60., true, 2));
        assert_eq!(hotspot_poll_delay(true), 120);
        assert_eq!(hotspot_poll_delay(false), 250);
        assert_eq!(NOTCH_WAVE_BUSY_MS, 55);
        assert_eq!(NOTCH_WAVE_IDLE_MS, 90);
        assert_eq!(ANNOTATION_SETTLE_MS, 700);
        assert_eq!(COMPUTER_CURSOR_LIFETIME_MS, 1400);
        assert_eq!(PILL_LINGER_MS + PILL_FADE_MS, 2720);
    }

    #[test]
    fn computer_progress_validation_matches_renderer_boundary() {
        let mut progress = ComputerProgress::default();
        assert!(progress.valid());
        progress.cursor = Some(ComputerCursor {
            window_id: 1,
            bounds: SurfaceRect::new(10., 20., 400., 300.),
            x: 20.,
            y: 30.,
        });
        assert!(progress.valid());
        let rounded = progress.cursor.as_ref().and_then(ComputerCursor::rounded);
        assert_eq!(
            rounded.map(|cursor| cursor.bounds),
            Some(SurfaceRect::new(10., 20., 400., 300.))
        );
        progress.actions = 21;
        assert!(!progress.valid());
        progress.actions = 0;
        progress.cursor.as_mut().expect("cursor").x = 500.;
        assert!(!progress.valid());
    }

    #[test]
    fn overlay_state_and_actions_have_safe_defaults() {
        let state = OverlayState::default();
        assert_eq!(state.surface, OverlaySurface::Notch);
        assert_eq!(state.notch.width, 180.);
        assert_eq!(state.notch.height, 32.);
        assert_eq!(state.mode, PermissionMode::Ask);
        assert!(!state.busy);
        assert!(!state.reduced_motion);
        assert_eq!(
            ComputerProgress::default().action,
            SharedString::from("Starting")
        );
        assert_eq!(AnnotationState::default(), AnnotationState::default());
        assert_eq!(OverlayAction::OpenOverlay, OverlayAction::OpenOverlay);
        assert_eq!(
            OverlayAction::FinishAnnotation,
            OverlayAction::FinishAnnotation
        );
        assert_eq!(
            OverlayAction::CancelAnnotation,
            OverlayAction::CancelAnnotation
        );
    }
}
