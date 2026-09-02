use std::{
    cell::Cell,
    collections::VecDeque,
    env, fmt,
    ops::Range,
    path::Path,
    rc::Rc,
    sync::{
        Arc, Mutex,
        mpsc::{self, Receiver, SyncSender, TrySendError},
    },
};

use gpui::accesskit::Role;
use gpui::prelude::FluentBuilder as _;
use gpui::{
    AnyElement, App, Bounds, ClipboardItem, Context, ElementInputHandler, EntityInputHandler,
    FocusHandle, Focusable, FontStyle, FontWeight, InteractiveElement, IntoElement, MouseButton,
    MouseDownEvent, MouseMoveEvent, MouseUpEvent, ParentElement, Render, ScrollDelta,
    StatefulInteractiveElement, Styled, StyledText, UTF16Selection, UnderlineStyle, Window, canvas,
    div, point, px, rgb, size,
};
use gpui_component::{
    Disableable as _, Selectable as _, Sizable as _,
    button::{Button, ButtonVariants as _},
    h_flex, v_flex,
};

use crate::theme::EmmaTheme;

pub const MAX_TERMINAL_TABS: usize = 8;
pub const MAX_TERMINAL_SCROLLBACK: usize = 256 * 1024;
pub const MAX_TERMINAL_INPUT: usize = 64 * 1024;
pub const MAX_TERMINAL_COLUMNS: u16 = 4096;
pub const MAX_TERMINAL_ROWS: u16 = 4096;
pub const MAX_TERMINAL_SELECTION_LINES: usize = 200;
pub const MAX_TERMINAL_SELECTION_CHARS: usize = 16 * 1024;
pub const MAX_TERMINAL_EVENT_BYTES: usize = 64 * 1024;
pub const MAX_TERMINAL_OSC_BYTES: usize = 8192;
pub const MAX_TERMINAL_ID_BYTES: usize = 128;
pub const MAX_TERMINAL_THREAD_ID_BYTES: usize = 256;
pub const MAX_TERMINAL_PATH_BYTES: usize = 4096;
pub const MAX_TERMINAL_ARGUMENT_BYTES: usize = 4096;
pub const MAX_TERMINAL_ARGUMENTS: usize = 128;
pub const MAX_TERMINAL_ENVIRONMENT: usize = 128;
pub const MAX_TERMINAL_ENV_NAME_BYTES: usize = 256;
pub const MAX_TERMINAL_ENV_VALUE_BYTES: usize = 8192;
pub const MAX_TERMINAL_TITLE_BYTES: usize = 256;
pub const DEFAULT_TERMINAL_COLUMNS: u16 = 80;
pub const DEFAULT_TERMINAL_ROWS: u16 = 24;
pub const PTY_HELPER_NAME: &str = "emma-pty";
pub const DEFAULT_TERMINAL_HEIGHT: f32 = 260.;
pub const MIN_TERMINAL_HEIGHT: f32 = 120.;
pub const MAX_TERMINAL_HEIGHT: f32 = 720.;
pub const TERMINAL_TAB_HEIGHT: f32 = 30.;
pub const TERMINAL_TOP_PADDING: f32 = 8.;
pub const TERMINAL_LEFT_PADDING: f32 = 8.;
pub const TERMINAL_FONT_SIZE: f32 = 12.;
pub const TERMINAL_LINE_HEIGHT: f32 = 16.;
pub const TERMINAL_CELL_WIDTH: f32 = 7.2;

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalError {
    InvalidRequest(&'static str),
    UnknownSession,
    SessionLimit,
    QueueFull,
    TransportClosed,
    Transport(String),
}

impl fmt::Display for TerminalError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidRequest(label) => write!(formatter, "terminal {label} is invalid"),
            Self::UnknownSession => formatter.write_str("terminal session is unknown"),
            Self::SessionLimit => formatter.write_str("a thread keeps at most 8 terminals open"),
            Self::QueueFull => formatter.write_str("terminal worker queue is full"),
            Self::TransportClosed => formatter.write_str("terminal worker is unavailable"),
            Self::Transport(error) => formatter.write_str(error),
        }
    }
}

impl std::error::Error for TerminalError {}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum TerminalColor {
    #[default]
    Default,
    Indexed(u8),
    Rgb(u8, u8, u8),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct TerminalStyle {
    pub foreground: TerminalColor,
    pub background: TerminalColor,
    pub bold: bool,
    pub dim: bool,
    pub italic: bool,
    pub underline: bool,
    pub inverse: bool,
}

impl Default for TerminalStyle {
    fn default() -> Self {
        Self {
            foreground: TerminalColor::Default,
            background: TerminalColor::Default,
            bold: false,
            dim: false,
            italic: false,
            underline: false,
            inverse: false,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalCell {
    pub text: String,
    pub style: TerminalStyle,
    pub link: Option<String>,
}

impl TerminalCell {
    fn blank(style: TerminalStyle) -> Self {
        Self {
            text: " ".to_owned(),
            style,
            link: None,
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalLine {
    pub cells: Vec<TerminalCell>,
    pub wrapped: bool,
}

impl TerminalLine {
    fn blank(columns: usize, style: TerminalStyle) -> Self {
        Self {
            cells: (0..columns).map(|_| TerminalCell::blank(style)).collect(),
            wrapped: false,
        }
    }

    pub fn text(&self) -> String {
        let mut value = self
            .cells
            .iter()
            .map(|cell| cell.text.as_str())
            .collect::<String>();
        while value.ends_with(' ') {
            value.pop();
        }
        value
    }

    fn resize(&mut self, columns: usize, style: TerminalStyle) {
        if self.cells.len() > columns {
            self.cells.truncate(columns);
        } else {
            self.cells
                .extend((self.cells.len()..columns).map(|_| TerminalCell::blank(style)));
        }
    }
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct TerminalPoint {
    pub line: usize,
    pub column: usize,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalSelection {
    pub text: String,
    pub lines: usize,
    pub start: TerminalPoint,
    pub end: TerminalPoint,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SelectionRange {
    anchor: TerminalPoint,
    active: TerminalPoint,
}

#[derive(Clone, Debug)]
enum ParserState {
    Ground,
    Escape,
    Csi(Vec<u8>),
    Osc { bytes: Vec<u8>, escaped: bool },
}

#[derive(Clone, Debug)]
struct AlternateBuffer {
    screen: Vec<TerminalLine>,
    scrollback: VecDeque<TerminalLine>,
    cursor: TerminalPoint,
    saved_cursor: TerminalPoint,
    style: TerminalStyle,
    saved_style: TerminalStyle,
    title: String,
}

#[derive(Clone, Debug)]
pub struct AnsiScreen {
    columns: usize,
    rows: usize,
    screen: Vec<TerminalLine>,
    scrollback: VecDeque<TerminalLine>,
    cursor: TerminalPoint,
    saved_cursor: TerminalPoint,
    style: TerminalStyle,
    saved_style: TerminalStyle,
    parser: ParserState,
    utf8: Vec<u8>,
    title: String,
    active_link: Option<String>,
    alternate: Option<AlternateBuffer>,
    scroll_offset: usize,
    selection: Option<SelectionRange>,
    last_character: Option<char>,
}

impl AnsiScreen {
    pub fn new(columns: u16, rows: u16) -> Self {
        let columns = usize::from(columns.clamp(1, MAX_TERMINAL_COLUMNS));
        let rows = usize::from(rows.clamp(1, MAX_TERMINAL_ROWS));
        Self {
            columns,
            rows,
            screen: (0..rows)
                .map(|_| TerminalLine::blank(columns, TerminalStyle::default()))
                .collect(),
            scrollback: VecDeque::new(),
            cursor: TerminalPoint::default(),
            saved_cursor: TerminalPoint::default(),
            style: TerminalStyle::default(),
            saved_style: TerminalStyle::default(),
            parser: ParserState::Ground,
            utf8: Vec::new(),
            title: String::new(),
            active_link: None,
            alternate: None,
            scroll_offset: 0,
            selection: None,
            last_character: None,
        }
    }

    pub fn columns(&self) -> u16 {
        self.columns as u16
    }

    pub fn rows(&self) -> u16 {
        self.rows as u16
    }

    pub fn cursor(&self) -> TerminalPoint {
        TerminalPoint {
            line: self.screen.len().saturating_sub(1).min(self.cursor.line),
            column: self.columns.saturating_sub(1).min(self.cursor.column),
        }
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    pub fn is_alternate(&self) -> bool {
        self.alternate.is_some()
    }

    pub fn scroll_offset(&self) -> usize {
        self.scroll_offset
    }

    pub fn resize(&mut self, columns: u16, rows: u16) {
        let columns = usize::from(columns.clamp(1, MAX_TERMINAL_COLUMNS));
        let rows = usize::from(rows.clamp(1, MAX_TERMINAL_ROWS));
        let previous_style = self.style;
        for line in &mut self.screen {
            line.resize(columns, previous_style);
        }
        if self.screen.len() > rows {
            let count = self.screen.len() - rows;
            for _ in 0..count {
                if let Some(line) = self.screen.first().cloned() {
                    self.push_scrollback(line);
                }
                self.screen.remove(0);
            }
        } else {
            self.screen.extend(
                (self.screen.len()..rows).map(|_| TerminalLine::blank(columns, previous_style)),
            );
        }
        self.columns = columns;
        self.rows = rows;
        self.cursor.line = self.cursor.line.min(rows.saturating_sub(1));
        self.cursor.column = self.cursor.column.min(columns.saturating_sub(1));
        self.saved_cursor.line = self.saved_cursor.line.min(rows.saturating_sub(1));
        self.saved_cursor.column = self.saved_cursor.column.min(columns.saturating_sub(1));
        self.scroll_offset = self.scroll_offset.min(
            self.scrollback
                .len()
                .saturating_add(self.screen.len())
                .saturating_sub(rows),
        );
        if let Some(alternate) = &mut self.alternate {
            for line in &mut alternate.screen {
                line.resize(columns, previous_style);
            }
            if alternate.screen.len() > rows {
                alternate.screen.drain(0..alternate.screen.len() - rows);
            } else {
                alternate.screen.extend(
                    (alternate.screen.len()..rows)
                        .map(|_| TerminalLine::blank(columns, previous_style)),
                );
            }
            alternate.cursor.line = alternate.cursor.line.min(rows.saturating_sub(1));
            alternate.cursor.column = alternate.cursor.column.min(columns.saturating_sub(1));
            alternate.saved_cursor.line = alternate.saved_cursor.line.min(rows.saturating_sub(1));
            alternate.saved_cursor.column =
                alternate.saved_cursor.column.min(columns.saturating_sub(1));
        }
        self.selection = None;
    }

    pub fn reset(&mut self) {
        self.screen = (0..self.rows)
            .map(|_| TerminalLine::blank(self.columns, TerminalStyle::default()))
            .collect();
        self.scrollback.clear();
        self.cursor = TerminalPoint::default();
        self.saved_cursor = TerminalPoint::default();
        self.style = TerminalStyle::default();
        self.saved_style = TerminalStyle::default();
        self.parser = ParserState::Ground;
        self.utf8.clear();
        self.title.clear();
        self.active_link = None;
        self.scroll_offset = 0;
        self.selection = None;
        self.last_character = None;
    }

    pub fn feed(&mut self, bytes: &[u8]) {
        for &byte in bytes.iter().take(MAX_TERMINAL_EVENT_BYTES) {
            self.consume(byte);
        }
    }

    pub fn all_lines(&self) -> Vec<TerminalLine> {
        self.scrollback
            .iter()
            .cloned()
            .chain(self.screen.iter().cloned())
            .collect()
    }

    pub fn visible_lines(&self) -> Vec<TerminalLine> {
        let lines = self.all_lines();
        let total = lines.len();
        let end = total.saturating_sub(self.scroll_offset);
        let start = end.saturating_sub(self.rows);
        lines[start..end].to_vec()
    }

    pub fn visible_start(&self) -> usize {
        self.scrollback
            .len()
            .saturating_add(self.screen.len())
            .saturating_sub(self.scroll_offset)
            .saturating_sub(self.rows)
    }

    pub fn text(&self) -> String {
        self.visible_lines()
            .iter()
            .map(TerminalLine::text)
            .collect::<Vec<_>>()
            .join("\n")
    }

    pub fn scroll_by(&mut self, delta: i32) {
        let maximum = self
            .scrollback
            .len()
            .saturating_add(self.screen.len())
            .saturating_sub(self.rows);
        if delta >= 0 {
            self.scroll_offset = self
                .scroll_offset
                .saturating_add(delta as usize)
                .min(maximum);
        } else {
            self.scroll_offset = self
                .scroll_offset
                .saturating_sub(delta.unsigned_abs() as usize);
        }
    }

    pub fn scroll_to_bottom(&mut self) {
        self.scroll_offset = 0;
    }

    pub fn begin_selection(&mut self, point: TerminalPoint) {
        let point = self.clamp_point(point);
        self.selection = Some(SelectionRange {
            anchor: point,
            active: point,
        });
    }

    pub fn update_selection(&mut self, point: TerminalPoint) {
        if self.selection.is_some() {
            let point = self.clamp_point(point);
            if let Some(selection) = &mut self.selection {
                selection.active = point;
            }
        }
    }

    pub fn clear_selection(&mut self) {
        self.selection = None;
    }

    pub fn selection(&self) -> Option<TerminalSelection> {
        let selection = self.selection.as_ref()?;
        let (start, end) = if point_key(selection.anchor) <= point_key(selection.active) {
            (selection.anchor, selection.active)
        } else {
            (selection.active, selection.anchor)
        };
        let lines = self.all_lines();
        if lines.is_empty() {
            return None;
        }
        let last_line = end.line.min(lines.len().saturating_sub(1));
        let first_line = start.line.min(last_line);
        let mut selected = Vec::new();
        for (line_index, line) in lines
            .iter()
            .enumerate()
            .take(last_line + 1)
            .skip(first_line)
        {
            let start_column = if line_index == first_line {
                start.column
            } else {
                0
            };
            let end_column = if line_index == last_line {
                end.column
            } else {
                line.cells.len()
            };
            let text = line
                .cells
                .iter()
                .skip(start_column.min(line.cells.len()))
                .take(
                    end_column
                        .saturating_sub(start_column)
                        .min(line.cells.len()),
                )
                .map(|cell| cell.text.as_str())
                .collect::<String>();
            selected.push(text.trim_end_matches(' ').to_owned());
        }
        while selected.first().is_some_and(|line| line.trim().is_empty()) {
            selected.remove(0);
        }
        while selected.last().is_some_and(|line| line.trim().is_empty()) {
            selected.pop();
        }
        if selected.is_empty() {
            return None;
        }
        let line_count = selected.len();
        let kept = selected
            .iter()
            .take(MAX_TERMINAL_SELECTION_LINES)
            .cloned()
            .collect::<Vec<_>>();
        let dropped = line_count.saturating_sub(kept.len());
        let mut text = kept.join("\n");
        if text.len() > MAX_TERMINAL_SELECTION_CHARS {
            text.truncate(MAX_TERMINAL_SELECTION_CHARS);
        }
        if dropped > 0 {
            text.push_str(&format!("\n[{dropped} more lines not attached]"));
        }
        Some(TerminalSelection {
            text,
            lines: line_count,
            start,
            end,
        })
    }

    pub fn link_at(&self, point: TerminalPoint) -> Option<String> {
        let lines = self.all_lines();
        let line = lines.get(point.line)?;
        let column = point.column.min(line.cells.len());
        if let Some(link) = line.cells.get(column).and_then(|cell| cell.link.clone()) {
            return Some(link);
        }
        let text = line.text();
        let spans = find_urls(&text);
        spans
            .into_iter()
            .find(|(start, end, _)| column >= *start && column < *end)
            .map(|(_, _, url)| url)
    }

    fn consume(&mut self, byte: u8) {
        match &mut self.parser {
            ParserState::Ground => self.consume_ground(byte),
            ParserState::Escape => self.consume_escape(byte),
            ParserState::Csi(bytes) => {
                if (0x40..=0x7e).contains(&byte) {
                    let data = std::mem::take(bytes);
                    self.parser = ParserState::Ground;
                    self.execute_csi(byte, &data);
                } else if bytes.len() < 128 {
                    bytes.push(byte);
                } else {
                    self.parser = ParserState::Ground;
                }
            }
            ParserState::Osc { bytes, escaped } => {
                if *escaped {
                    *escaped = false;
                    if byte == b'\\' {
                        let data = std::mem::take(bytes);
                        self.parser = ParserState::Ground;
                        self.execute_osc(&data);
                    } else if bytes.len() < MAX_TERMINAL_OSC_BYTES {
                        bytes.push(0x1b);
                        bytes.push(byte);
                    } else {
                        self.parser = ParserState::Ground;
                    }
                } else if byte == 0x07 {
                    let data = std::mem::take(bytes);
                    self.parser = ParserState::Ground;
                    self.execute_osc(&data);
                } else if byte == 0x1b {
                    *escaped = true;
                } else if bytes.len() < MAX_TERMINAL_OSC_BYTES {
                    bytes.push(byte);
                } else {
                    self.parser = ParserState::Ground;
                }
            }
        }
    }

    fn consume_ground(&mut self, byte: u8) {
        match byte {
            0x1b => {
                self.flush_utf8();
                self.parser = ParserState::Escape;
            }
            0x00..=0x08 | 0x0b..=0x0c | 0x0e..=0x1f | 0x7f => {
                self.flush_utf8();
                self.control(byte);
            }
            0x09 => {
                self.flush_utf8();
                self.tab();
            }
            0x0a => {
                self.flush_utf8();
                self.line_feed(false);
            }
            0x0d => {
                self.flush_utf8();
                self.cursor.column = 0;
            }
            0x20..=0x7e => self.put_char(byte as char),
            _ => {
                self.utf8.push(byte);
                match std::str::from_utf8(&self.utf8) {
                    Ok(text) => {
                        let text = text.to_owned();
                        self.utf8.clear();
                        for character in text.chars() {
                            self.put_char(character);
                        }
                    }
                    Err(error) if error.error_len().is_some() => {
                        self.utf8.clear();
                        self.put_char('\u{fffd}');
                    }
                    Err(_) => {}
                }
            }
        }
    }

    fn consume_escape(&mut self, byte: u8) {
        self.parser = ParserState::Ground;
        match byte {
            b'[' => self.parser = ParserState::Csi(Vec::new()),
            b']' => {
                self.parser = ParserState::Osc {
                    bytes: Vec::new(),
                    escaped: false,
                }
            }
            b'7' => self.save_cursor(),
            b'8' => self.restore_cursor(),
            b'c' => self.reset(),
            b'D' => self.line_feed(false),
            b'E' => self.line_feed(true),
            b'M' => self.reverse_index(),
            b'=' | b'>' | b'(' | b')' | b'#' | b'%' => {}
            0x20..=0x2f => self.parser = ParserState::Escape,
            _ => self.consume_ground(byte),
        }
    }

    fn control(&mut self, byte: u8) {
        match byte {
            0x08 => self.cursor.column = self.cursor.column.saturating_sub(1),
            0x0a => self.line_feed(false),
            0x0b | 0x0c => self.line_feed(false),
            _ => {}
        }
    }

    fn tab(&mut self) {
        let next = ((self.cursor.column / 8) + 1) * 8;
        self.cursor.column = next.min(self.columns.saturating_sub(1));
    }

    fn line_feed(&mut self, carriage_return: bool) {
        if carriage_return {
            self.cursor.column = 0;
        }
        if self.cursor.line + 1 >= self.rows {
            self.scroll_up();
        } else {
            self.cursor.line += 1;
        }
    }

    fn reverse_index(&mut self) {
        if self.cursor.line == 0 {
            if let Some(first) = self.screen.first().cloned() {
                self.screen
                    .insert(0, TerminalLine::blank(self.columns, first.cells[0].style));
                self.screen.pop();
            }
        } else {
            self.cursor.line -= 1;
        }
    }

    fn scroll_up(&mut self) {
        if let Some(line) = self.screen.first().cloned() {
            self.push_scrollback(line);
        }
        self.screen.remove(0);
        self.screen
            .push(TerminalLine::blank(self.columns, self.style));
        self.scroll_offset = 0;
    }

    fn push_scrollback(&mut self, line: TerminalLine) {
        self.scrollback.push_back(line);
        while self.scrollback.len() > MAX_TERMINAL_SCROLLBACK / self.columns.max(1) {
            self.scrollback.pop_front();
        }
    }

    fn put_char(&mut self, character: char) {
        if self.columns == 0 || self.rows == 0 {
            return;
        }
        if self.cursor.column >= self.columns {
            if let Some(line) = self.screen.get_mut(self.cursor.line) {
                line.wrapped = true;
            }
            self.cursor.column = 0;
            self.line_feed(false);
        }
        if is_combining(character)
            && self.cursor.column > 0
            && let Some(cell) = self
                .screen
                .get_mut(self.cursor.line)
                .and_then(|line| line.cells.get_mut(self.cursor.column - 1))
        {
            cell.text.push(character);
            self.last_character = Some(character);
            return;
        }
        if let Some(cell) = self
            .screen
            .get_mut(self.cursor.line)
            .and_then(|line| line.cells.get_mut(self.cursor.column))
        {
            cell.text.clear();
            cell.text.push(character);
            cell.style = self.style;
            cell.link = self.active_link.clone();
        }
        self.last_character = Some(character);
        self.cursor.column += 1;
    }

    fn flush_utf8(&mut self) {
        if self.utf8.is_empty() {
            return;
        }
        self.utf8.clear();
        self.put_char('\u{fffd}');
    }

    fn execute_csi(&mut self, final_byte: u8, data: &[u8]) {
        let private = data.first().is_some_and(|byte| *byte == b'?');
        let data = if private { &data[1..] } else { data };
        let values = parse_csi_values(data);
        let first = values.first().copied().flatten();
        let count = first.unwrap_or(1).max(1);
        match final_byte {
            b'A' => self.cursor.line = self.cursor.line.saturating_sub(count),
            b'B' | b'e' => {
                self.cursor.line = (self.cursor.line + count).min(self.rows.saturating_sub(1));
            }
            b'C' | b'a' => {
                self.cursor.column =
                    (self.cursor.column + count).min(self.columns.saturating_sub(1));
            }
            b'D' => self.cursor.column = self.cursor.column.saturating_sub(count),
            b'E' => {
                self.cursor.line = (self.cursor.line + count).min(self.rows.saturating_sub(1));
                self.cursor.column = 0;
            }
            b'F' => {
                self.cursor.line = self.cursor.line.saturating_sub(count);
                self.cursor.column = 0;
            }
            b'G' | b'`' => {
                self.cursor.column = first
                    .unwrap_or(1)
                    .saturating_sub(1)
                    .min(self.columns.saturating_sub(1));
            }
            b'd' => {
                self.cursor.line = first
                    .unwrap_or(1)
                    .saturating_sub(1)
                    .min(self.rows.saturating_sub(1));
            }
            b'H' | b'f' => {
                self.cursor.line = values
                    .first()
                    .copied()
                    .flatten()
                    .unwrap_or(1)
                    .saturating_sub(1)
                    .min(self.rows.saturating_sub(1));
                self.cursor.column = values
                    .get(1)
                    .copied()
                    .flatten()
                    .unwrap_or(1)
                    .saturating_sub(1)
                    .min(self.columns.saturating_sub(1));
            }
            b'J' => self.erase_display(first.unwrap_or(0)),
            b'K' => self.erase_line(first.unwrap_or(0)),
            b'P' => self.delete_chars(count),
            b'@' => self.insert_chars(count),
            b'X' => self.erase_chars(count),
            b'L' => self.insert_lines(count),
            b'M' => self.delete_lines(count),
            b'S' => (0..count).for_each(|_| self.scroll_up()),
            b'T' => (0..count).for_each(|_| self.reverse_index()),
            b'm' => self.sgr(data),
            b's' => self.save_cursor(),
            b'u' => self.restore_cursor(),
            b'b' => {
                if let Some(character) = self.last_character {
                    for _ in 0..count {
                        self.put_char(character);
                    }
                }
            }
            b'h' if private => self.set_private_mode(values, true),
            b'l' if private => self.set_private_mode(values, false),
            _ => {}
        }
    }

    fn erase_display(&mut self, mode: usize) {
        match mode {
            0 => {
                self.erase_line_from(self.cursor.column);
                for line in self.screen.iter_mut().skip(self.cursor.line + 1) {
                    *line = TerminalLine::blank(self.columns, self.style);
                }
            }
            1 => {
                self.erase_line_to(self.cursor.column);
                for line in self.screen.iter_mut().take(self.cursor.line) {
                    *line = TerminalLine::blank(self.columns, self.style);
                }
            }
            2 | 3 => {
                self.screen = (0..self.rows)
                    .map(|_| TerminalLine::blank(self.columns, self.style))
                    .collect();
                if mode == 3 {
                    self.scrollback.clear();
                }
            }
            _ => {}
        }
    }

    fn erase_line(&mut self, mode: usize) {
        match mode {
            0 => self.erase_line_from(self.cursor.column),
            1 => self.erase_line_to(self.cursor.column),
            2 => {
                if let Some(line) = self.screen.get_mut(self.cursor.line) {
                    *line = TerminalLine::blank(self.columns, self.style);
                }
            }
            _ => {}
        }
    }

    fn erase_line_from(&mut self, column: usize) {
        if let Some(line) = self.screen.get_mut(self.cursor.line) {
            for cell in line.cells.iter_mut().skip(column.min(self.columns)) {
                *cell = TerminalCell::blank(self.style);
            }
        }
    }

    fn erase_line_to(&mut self, column: usize) {
        if let Some(line) = self.screen.get_mut(self.cursor.line) {
            for cell in line
                .cells
                .iter_mut()
                .take(column.saturating_add(1).min(self.columns))
            {
                *cell = TerminalCell::blank(self.style);
            }
        }
    }

    fn erase_chars(&mut self, count: usize) {
        if let Some(line) = self.screen.get_mut(self.cursor.line) {
            for cell in line.cells.iter_mut().skip(self.cursor.column).take(count) {
                *cell = TerminalCell::blank(self.style);
            }
        }
    }

    fn delete_chars(&mut self, count: usize) {
        if let Some(line) = self.screen.get_mut(self.cursor.line) {
            let start = self.cursor.column.min(line.cells.len());
            let end = (start + count).min(line.cells.len());
            line.cells.drain(start..end);
            line.cells
                .extend((line.cells.len()..self.columns).map(|_| TerminalCell::blank(self.style)));
        }
    }

    fn insert_chars(&mut self, count: usize) {
        if let Some(line) = self.screen.get_mut(self.cursor.line) {
            let start = self.cursor.column.min(line.cells.len());
            let count = count.min(self.columns.saturating_sub(start));
            line.cells.splice(
                start..start,
                (0..count).map(|_| TerminalCell::blank(self.style)),
            );
            line.cells.truncate(self.columns);
        }
    }

    fn insert_lines(&mut self, count: usize) {
        let at = self.cursor.line.min(self.rows);
        for _ in 0..count.min(self.rows.saturating_sub(at)) {
            self.screen
                .insert(at, TerminalLine::blank(self.columns, self.style));
            self.screen.pop();
        }
    }

    fn delete_lines(&mut self, count: usize) {
        let at = self.cursor.line.min(self.rows);
        for _ in 0..count.min(self.rows.saturating_sub(at)) {
            if at < self.screen.len() {
                self.screen.remove(at);
            }
            self.screen
                .push(TerminalLine::blank(self.columns, self.style));
        }
    }

    fn sgr(&mut self, data: &[u8]) {
        let values = parse_sgr_values(data);
        if values.is_empty() {
            self.style = TerminalStyle::default();
            return;
        }
        let mut index = 0;
        while index < values.len() {
            let value = values[index];
            match value {
                0 => self.style = TerminalStyle::default(),
                1 => self.style.bold = true,
                2 => self.style.dim = true,
                3 => self.style.italic = true,
                4 => self.style.underline = true,
                7 => self.style.inverse = true,
                22 => {
                    self.style.bold = false;
                    self.style.dim = false;
                }
                23 => self.style.italic = false,
                24 => self.style.underline = false,
                27 => self.style.inverse = false,
                30..=37 => self.style.foreground = TerminalColor::Indexed((value - 30) as u8),
                38 => {
                    if let Some((color, used)) = parse_extended_color(&values[index + 1..]) {
                        self.style.foreground = color;
                        index += used;
                    }
                }
                39 => self.style.foreground = TerminalColor::Default,
                40..=47 => self.style.background = TerminalColor::Indexed((value - 40) as u8),
                48 => {
                    if let Some((color, used)) = parse_extended_color(&values[index + 1..]) {
                        self.style.background = color;
                        index += used;
                    }
                }
                49 => self.style.background = TerminalColor::Default,
                90..=97 => self.style.foreground = TerminalColor::Indexed((value - 90 + 8) as u8),
                100..=107 => {
                    self.style.background = TerminalColor::Indexed((value - 100 + 8) as u8)
                }
                _ => {}
            }
            index += 1;
        }
    }

    fn set_private_mode(&mut self, values: Vec<Option<usize>>, enabled: bool) {
        for value in values.into_iter().flatten() {
            match value {
                7 => {}
                25 => {}
                47 | 1047 | 1049 if enabled => self.enter_alternate(),
                47 | 1047 | 1049 => self.leave_alternate(),
                _ => {}
            }
        }
    }

    fn save_cursor(&mut self) {
        self.saved_cursor = self.cursor;
        self.saved_style = self.style;
    }

    fn restore_cursor(&mut self) {
        self.cursor = self.saved_cursor;
        self.style = self.saved_style;
        self.cursor.line = self.cursor.line.min(self.rows.saturating_sub(1));
        self.cursor.column = self.cursor.column.min(self.columns.saturating_sub(1));
    }

    fn enter_alternate(&mut self) {
        if self.alternate.is_some() {
            return;
        }
        self.alternate = Some(AlternateBuffer {
            screen: std::mem::take(&mut self.screen),
            scrollback: std::mem::take(&mut self.scrollback),
            cursor: self.cursor,
            saved_cursor: self.saved_cursor,
            style: self.style,
            saved_style: self.saved_style,
            title: std::mem::take(&mut self.title),
        });
        self.screen = (0..self.rows)
            .map(|_| TerminalLine::blank(self.columns, TerminalStyle::default()))
            .collect();
        self.scrollback.clear();
        self.cursor = TerminalPoint::default();
        self.saved_cursor = TerminalPoint::default();
        self.style = TerminalStyle::default();
        self.saved_style = TerminalStyle::default();
        self.title.clear();
        self.scroll_offset = 0;
        self.selection = None;
    }

    fn leave_alternate(&mut self) {
        let Some(alternate) = self.alternate.take() else {
            return;
        };
        self.screen = alternate.screen;
        self.scrollback = alternate.scrollback;
        self.cursor = alternate.cursor;
        self.saved_cursor = alternate.saved_cursor;
        self.style = alternate.style;
        self.saved_style = alternate.saved_style;
        self.title = alternate.title;
        self.scroll_offset = 0;
        self.selection = None;
    }

    fn execute_osc(&mut self, data: &[u8]) {
        let Ok(value) = std::str::from_utf8(data) else {
            return;
        };
        let Some((command, payload)) = value.split_once(';') else {
            return;
        };
        let command = command.parse::<u16>().ok();
        match command {
            Some(0) | Some(2) => {
                self.title = bounded_text(payload, MAX_TERMINAL_TITLE_BYTES);
            }
            Some(8) => {
                let link = payload.split_once(';').map_or("", |(_, value)| value);
                self.active_link = if link.is_empty() {
                    None
                } else {
                    sanitize_link(link)
                };
            }
            _ => {}
        }
    }

    fn clamp_point(&self, point: TerminalPoint) -> TerminalPoint {
        let lines = self.all_lines();
        TerminalPoint {
            line: point.line.min(lines.len().saturating_sub(1)),
            column: point.column.min(self.columns),
        }
    }
}

fn point_key(point: TerminalPoint) -> (usize, usize) {
    (point.line, point.column)
}

fn parse_csi_values(data: &[u8]) -> Vec<Option<usize>> {
    data.split(|byte| *byte == b';' || *byte == b':')
        .map(|part| {
            if part.is_empty() {
                None
            } else {
                std::str::from_utf8(part)
                    .ok()
                    .and_then(|value| value.parse::<usize>().ok())
            }
        })
        .collect()
}

fn parse_sgr_values(data: &[u8]) -> Vec<usize> {
    parse_csi_values(data)
        .into_iter()
        .map(|value| value.unwrap_or(0))
        .collect()
}

fn parse_extended_color(values: &[usize]) -> Option<(TerminalColor, usize)> {
    match values.first().copied()? {
        5 => Some((
            TerminalColor::Indexed(u8::try_from(*values.get(1)?).ok()?),
            2,
        )),
        2 => Some((
            TerminalColor::Rgb(
                u8::try_from(*values.get(1)?).ok()?,
                u8::try_from(*values.get(2)?).ok()?,
                u8::try_from(*values.get(3)?).ok()?,
            ),
            4,
        )),
        _ => None,
    }
}

fn is_combining(character: char) -> bool {
    matches!(
        character as u32,
        0x0300..=0x036f
            | 0x1ab0..=0x1aff
            | 0x1dc0..=0x1dff
            | 0x20d0..=0x20ff
            | 0xfe20..=0xfe2f
    )
}

fn bounded_text(value: &str, max_bytes: usize) -> String {
    let mut result = value.to_owned();
    while result.len() > max_bytes {
        result.pop();
    }
    result
}

fn sanitize_link(value: &str) -> Option<String> {
    if value.len() > 2048 || value.chars().any(char::is_control) {
        return None;
    }
    let value = value.trim();
    if value.starts_with("https://") || value.starts_with("http://") {
        Some(value.to_owned())
    } else {
        None
    }
}

fn find_urls(value: &str) -> Vec<(usize, usize, String)> {
    let mut result = Vec::new();
    let mut search_from = 0;
    for raw in value.split_whitespace() {
        let Some(byte_start) = value[search_from..].find(raw) else {
            continue;
        };
        let byte_start = search_from + byte_start;
        let start = value[..byte_start].chars().count();
        let candidate = raw.trim_matches(|character: char| "([{<\"'".contains(character));
        let candidate =
            candidate.trim_end_matches(|character: char| ".,;:!?)]}>\"'".contains(character));
        if let Some(url) = sanitize_link(candidate) {
            let prefix = raw.find(candidate).unwrap_or(0);
            let leading = raw[..prefix].chars().count();
            result.push((
                start + leading,
                start + leading + candidate.chars().count(),
                url,
            ));
        }
        search_from = byte_start + raw.len();
    }
    result
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalOpen {
    pub id: Option<String>,
    pub thread_id: String,
    pub cwd: String,
    pub columns: u16,
    pub rows: u16,
    pub cli: Option<String>,
    pub argv: Option<Vec<String>>,
    pub environment: Vec<(String, String)>,
}

impl TerminalOpen {
    pub fn new(thread_id: impl Into<String>, cwd: impl Into<String>) -> Self {
        Self {
            id: None,
            thread_id: thread_id.into(),
            cwd: cwd.into(),
            columns: DEFAULT_TERMINAL_COLUMNS,
            rows: DEFAULT_TERMINAL_ROWS,
            cli: None,
            argv: None,
            environment: Vec::new(),
        }
    }

    fn validate(&self) -> Result<(), TerminalError> {
        validate_id(&self.thread_id, MAX_TERMINAL_THREAD_ID_BYTES, "thread id")?;
        if let Some(id) = &self.id {
            validate_id(id, MAX_TERMINAL_ID_BYTES, "id")?;
        }
        validate_path(&self.cwd)?;
        validate_size(self.columns, "columns")?;
        validate_size(self.rows, "rows")?;
        if let Some(cli) = &self.cli {
            validate_text(cli, MAX_TERMINAL_ARGUMENT_BYTES, "cli")?;
        }
        if let Some(argv) = &self.argv {
            if argv.is_empty() || argv.len() > MAX_TERMINAL_ARGUMENTS {
                return Err(TerminalError::InvalidRequest("argv"));
            }
            for argument in argv {
                validate_text(argument, MAX_TERMINAL_ARGUMENT_BYTES, "argument")?;
            }
        }
        if self.environment.len() > MAX_TERMINAL_ENVIRONMENT {
            return Err(TerminalError::InvalidRequest("environment"));
        }
        for (name, value) in &self.environment {
            validate_text(name, MAX_TERMINAL_ENV_NAME_BYTES, "environment name")?;
            validate_text(value, MAX_TERMINAL_ENV_VALUE_BYTES, "environment value")?;
            if name.is_empty() || name.contains('=') {
                return Err(TerminalError::InvalidRequest("environment name"));
            }
        }
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PtySpawn {
    pub id: String,
    pub thread_id: String,
    pub cwd: String,
    pub columns: u16,
    pub rows: u16,
    pub argv: Vec<String>,
    pub environment: Vec<(String, String)>,
}

impl PtySpawn {
    fn from_request(id: String, request: &TerminalOpen) -> Result<Self, TerminalError> {
        let argv = match (&request.argv, &request.cli) {
            (Some(argv), _) => argv.clone(),
            (None, Some(cli)) => cli_argv(cli).ok_or(TerminalError::InvalidRequest("cli"))?,
            (None, None) => default_shell_argv(),
        };
        let mut environment = request
            .environment
            .iter()
            .filter(|(name, _)| name != "TERM" && name != "COLORTERM")
            .cloned()
            .collect::<Vec<_>>();
        environment.push(("TERM".to_owned(), "xterm-256color".to_owned()));
        environment.push(("COLORTERM".to_owned(), "truecolor".to_owned()));
        let spawn = Self {
            id,
            thread_id: request.thread_id.clone(),
            cwd: request.cwd.clone(),
            columns: request.columns,
            rows: request.rows,
            argv,
            environment,
        };
        spawn.validate()?;
        Ok(spawn)
    }

    pub fn helper_arguments(&self) -> Vec<String> {
        let mut arguments = vec![self.columns.to_string(), self.rows.to_string()];
        arguments.extend(self.argv.clone());
        arguments
    }

    pub fn resize_line(columns: u16, rows: u16) -> Result<String, TerminalError> {
        validate_size(columns, "columns")?;
        validate_size(rows, "rows")?;
        Ok(format!("{columns} {rows}\n"))
    }

    fn validate(&self) -> Result<(), TerminalError> {
        validate_id(&self.id, MAX_TERMINAL_ID_BYTES, "id")?;
        validate_id(&self.thread_id, MAX_TERMINAL_THREAD_ID_BYTES, "thread id")?;
        validate_path(&self.cwd)?;
        validate_size(self.columns, "columns")?;
        validate_size(self.rows, "rows")?;
        if self.argv.is_empty() || self.argv.len() > MAX_TERMINAL_ARGUMENTS {
            return Err(TerminalError::InvalidRequest("argv"));
        }
        for argument in &self.argv {
            validate_text(argument, MAX_TERMINAL_ARGUMENT_BYTES, "argument")?;
        }
        if self.environment.len() > MAX_TERMINAL_ENVIRONMENT {
            return Err(TerminalError::InvalidRequest("environment"));
        }
        for (name, value) in &self.environment {
            validate_text(name, MAX_TERMINAL_ENV_NAME_BYTES, "environment name")?;
            validate_text(value, MAX_TERMINAL_ENV_VALUE_BYTES, "environment value")?;
            if name.is_empty() || name.contains('=') {
                return Err(TerminalError::InvalidRequest("environment name"));
            }
        }
        Ok(())
    }
}

fn default_shell_argv() -> Vec<String> {
    #[cfg(windows)]
    {
        vec!["cmd.exe".to_owned(), "/d".to_owned()]
    }
    #[cfg(not(windows))]
    {
        vec![
            env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned()),
            "-il".to_owned(),
        ]
    }
}

fn cli_argv(cli: &str) -> Option<Vec<String>> {
    let binary = match cli {
        "claude" => "claude",
        "codex" => "codex",
        "pi" => "pi",
        "opencode" => "opencode",
        "gemini" => "gemini",
        "cursor" => "cursor-agent",
        _ => return None,
    };
    #[cfg(windows)]
    {
        Some(vec![
            env::var("COMSPEC").unwrap_or_else(|_| "cmd.exe".to_owned()),
            "/d".to_owned(),
            "/s".to_owned(),
            "/c".to_owned(),
            binary.to_owned(),
        ])
    }
    #[cfg(not(windows))]
    {
        Some(vec![
            env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_owned()),
            "-ilc".to_owned(),
            binary.to_owned(),
        ])
    }
}

fn cli_label(cli: &str) -> Option<&'static str> {
    match cli {
        "claude" => Some("Claude Code"),
        "codex" => Some("Codex"),
        "pi" => Some("Pi"),
        "opencode" => Some("OpenCode"),
        "gemini" => Some("Gemini CLI"),
        "cursor" => Some("Cursor CLI"),
        _ => None,
    }
}

fn validate_id(value: &str, max_bytes: usize, label: &'static str) -> Result<(), TerminalError> {
    validate_text(value, max_bytes, label)?;
    if value.is_empty() || value.chars().any(|character| character.is_control()) {
        return Err(TerminalError::InvalidRequest(label));
    }
    Ok(())
}

fn validate_path(value: &str) -> Result<(), TerminalError> {
    validate_text(value, MAX_TERMINAL_PATH_BYTES, "cwd")?;
    if value.is_empty() || value.contains('\0') || !Path::new(value).is_absolute() {
        return Err(TerminalError::InvalidRequest("cwd"));
    }
    Ok(())
}

fn validate_text(value: &str, max_bytes: usize, label: &'static str) -> Result<(), TerminalError> {
    if value.len() > max_bytes || value.contains('\0') {
        Err(TerminalError::InvalidRequest(label))
    } else {
        Ok(())
    }
}

fn validate_size(value: u16, label: &'static str) -> Result<(), TerminalError> {
    if value == 0 || value > MAX_TERMINAL_COLUMNS {
        Err(TerminalError::InvalidRequest(label))
    } else {
        Ok(())
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalCommand {
    Spawn(PtySpawn),
    Write { id: String, data: Vec<u8> },
    Resize { id: String, columns: u16, rows: u16 },
    Close { id: String },
    Replay { id: String, after: u64 },
}

impl TerminalCommand {
    fn validate(&self) -> Result<(), TerminalError> {
        match self {
            Self::Spawn(spawn) => spawn.validate(),
            Self::Write { id, data } => {
                validate_id(id, MAX_TERMINAL_ID_BYTES, "id")?;
                if data.len() > MAX_TERMINAL_INPUT {
                    Err(TerminalError::InvalidRequest("input"))
                } else {
                    Ok(())
                }
            }
            Self::Resize { id, columns, rows } => {
                validate_id(id, MAX_TERMINAL_ID_BYTES, "id")?;
                validate_size(*columns, "columns")?;
                validate_size(*rows, "rows")
            }
            Self::Close { id } | Self::Replay { id, .. } => {
                validate_id(id, MAX_TERMINAL_ID_BYTES, "id")
            }
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalEvent {
    Spawned { id: String },
    Output { id: String, data: Vec<u8>, at: u64 },
    Replay { id: String, data: Vec<u8>, at: u64 },
    Exited { id: String, code: Option<i32> },
    Error { id: String, message: String },
}

impl TerminalEvent {
    fn validate(&self) -> Result<(), TerminalError> {
        match self {
            Self::Spawned { id } | Self::Exited { id, .. } => {
                validate_id(id, MAX_TERMINAL_ID_BYTES, "id")
            }
            Self::Output { id, data, .. } | Self::Replay { id, data, .. } => {
                validate_id(id, MAX_TERMINAL_ID_BYTES, "id")?;
                if data.len() > MAX_TERMINAL_EVENT_BYTES {
                    Err(TerminalError::InvalidRequest("output"))
                } else {
                    Ok(())
                }
            }
            Self::Error { id, message } => {
                validate_id(id, MAX_TERMINAL_ID_BYTES, "id")?;
                validate_text(message, MAX_TERMINAL_TITLE_BYTES, "error")
            }
        }
    }
}

pub trait TerminalTransport: Send + Sync {
    fn send(&self, command: TerminalCommand) -> Result<(), TerminalError>;
    fn try_recv(&self) -> Option<TerminalEvent>;
}

pub struct TerminalWorkerPort {
    commands: Receiver<TerminalCommand>,
    events: SyncSender<TerminalEvent>,
}

impl TerminalWorkerPort {
    pub fn recv(&self) -> Result<TerminalCommand, TerminalError> {
        self.commands
            .recv()
            .map_err(|_| TerminalError::TransportClosed)
    }

    pub fn try_recv(&self) -> Option<TerminalCommand> {
        self.commands.try_recv().ok()
    }

    pub fn send_event(&self, event: TerminalEvent) -> Result<(), TerminalError> {
        event.validate()?;
        self.events.try_send(event).map_err(|error| match error {
            TrySendError::Full(_) => TerminalError::QueueFull,
            TrySendError::Disconnected(_) => TerminalError::TransportClosed,
        })
    }
}

pub struct ChannelTerminalTransport {
    commands: SyncSender<TerminalCommand>,
    events: Arc<Mutex<Receiver<TerminalEvent>>>,
}

impl ChannelTerminalTransport {
    pub fn channel(capacity: usize) -> Result<(Arc<Self>, TerminalWorkerPort), TerminalError> {
        if capacity == 0 {
            return Err(TerminalError::InvalidRequest("queue capacity"));
        }
        let (command_sender, command_receiver) = mpsc::sync_channel(capacity);
        let (event_sender, event_receiver) = mpsc::sync_channel(capacity);
        Ok((
            Arc::new(Self {
                commands: command_sender,
                events: Arc::new(Mutex::new(event_receiver)),
            }),
            TerminalWorkerPort {
                commands: command_receiver,
                events: event_sender,
            },
        ))
    }
}

impl TerminalTransport for ChannelTerminalTransport {
    fn send(&self, command: TerminalCommand) -> Result<(), TerminalError> {
        command.validate()?;
        self.commands
            .try_send(command)
            .map_err(|error| match error {
                TrySendError::Full(_) => TerminalError::QueueFull,
                TrySendError::Disconnected(_) => TerminalError::TransportClosed,
            })
    }

    fn try_recv(&self) -> Option<TerminalEvent> {
        let receiver = self.events.lock().ok()?;
        receiver.try_recv().ok()
    }
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum TerminalLifecycle {
    Loading,
    Ready,
    Exited(Option<i32>),
    Error,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalTab {
    pub id: String,
    pub thread_id: String,
    pub title: String,
    pub cwd: String,
    pub running: bool,
    pub exit_code: Option<i32>,
    pub lifecycle: TerminalLifecycle,
    pub columns: u16,
    pub rows: u16,
    pub cli: Option<String>,
    pub error: Option<String>,
}

#[derive(Clone, Debug)]
struct TerminalSession {
    tab: TerminalTab,
    screen: AnsiScreen,
    replay: VecDeque<u8>,
    replay_bytes: usize,
    written: u64,
    composition: String,
}

impl TerminalSession {
    fn new(id: String, request: &TerminalOpen) -> Self {
        Self {
            tab: TerminalTab {
                id,
                thread_id: request.thread_id.clone(),
                title: request
                    .cli
                    .as_deref()
                    .and_then(cli_label)
                    .map(str::to_owned)
                    .unwrap_or_else(|| terminal_title(&request.cwd)),
                cwd: request.cwd.clone(),
                running: true,
                exit_code: None,
                lifecycle: TerminalLifecycle::Loading,
                columns: request.columns,
                rows: request.rows,
                cli: request.cli.clone(),
                error: None,
            },
            screen: AnsiScreen::new(request.columns, request.rows),
            replay: VecDeque::new(),
            replay_bytes: 0,
            written: 0,
            composition: String::new(),
        }
    }

    fn append_output(&mut self, data: &[u8], at: Option<u64>) {
        let mut data = data;
        if let Some(at) = at {
            if at <= self.written {
                return;
            }
            let start = at.saturating_sub(data.len() as u64);
            if start < self.written {
                let skip = (self.written - start).min(data.len() as u64) as usize;
                data = data.get(skip..).unwrap_or_default();
            }
        }
        if data.is_empty() {
            return;
        }
        for chunk in data.chunks(MAX_TERMINAL_EVENT_BYTES) {
            self.screen.feed(chunk);
            self.written = self.written.saturating_add(chunk.len() as u64);
            for byte in chunk {
                self.replay.push_back(*byte);
                self.replay_bytes += 1;
            }
            while self.replay_bytes > MAX_TERMINAL_SCROLLBACK {
                self.replay.pop_front();
                self.replay_bytes -= 1;
            }
        }
        if let Some(at) = at {
            self.written = self.written.max(at);
        }
    }

    fn snapshot(&self) -> TerminalTab {
        self.tab.clone()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct TerminalBuffer {
    pub data: Vec<u8>,
    pub at: u64,
}

pub struct TerminalController {
    transport: Option<Arc<dyn TerminalTransport>>,
    sessions: Vec<TerminalSession>,
    active_id: Option<String>,
    next_id: u64,
}

impl TerminalController {
    pub fn new(transport: Option<Arc<dyn TerminalTransport>>) -> Self {
        Self {
            transport,
            sessions: Vec::new(),
            active_id: None,
            next_id: 1,
        }
    }

    pub fn set_transport(&mut self, transport: Arc<dyn TerminalTransport>) {
        self.transport = Some(transport);
    }

    pub fn active_id(&self) -> Option<&str> {
        self.active_id.as_deref()
    }

    pub fn select(&mut self, id: &str) -> Result<(), TerminalError> {
        if self.sessions.iter().any(|session| session.tab.id == id) {
            self.active_id = Some(id.to_owned());
            Ok(())
        } else {
            Err(TerminalError::UnknownSession)
        }
    }

    pub fn open(&mut self, request: TerminalOpen) -> Result<TerminalTab, TerminalError> {
        request.validate()?;
        if self
            .sessions
            .iter()
            .filter(|session| session.tab.thread_id == request.thread_id)
            .count()
            >= MAX_TERMINAL_TABS
        {
            return Err(TerminalError::SessionLimit);
        }
        let id = request.id.clone().unwrap_or_else(|| self.new_id());
        if self.sessions.iter().any(|session| session.tab.id == id) {
            return Err(TerminalError::InvalidRequest("id"));
        }
        let spawn = PtySpawn::from_request(id.clone(), &request)?;
        let session = TerminalSession::new(id.clone(), &request);
        self.sessions.push(session);
        self.active_id = Some(id.clone());
        let result = self.dispatch(TerminalCommand::Spawn(spawn));
        if let Err(error) = result
            && let Some(session) = self.session_mut(&id)
        {
            session.tab.lifecycle = TerminalLifecycle::Error;
            session.tab.running = false;
            session.tab.error = Some(error.to_string());
        }
        self.session(&id)
            .map(TerminalSession::snapshot)
            .ok_or(TerminalError::UnknownSession)
    }

    pub fn close(&mut self, id: &str) -> Result<(), TerminalError> {
        let index = self
            .sessions
            .iter()
            .position(|session| session.tab.id == id)
            .ok_or(TerminalError::UnknownSession)?;
        let _ = self.dispatch(TerminalCommand::Close { id: id.to_owned() });
        self.sessions.remove(index);
        if self.active_id.as_deref() == Some(id) {
            self.active_id = self
                .sessions
                .get(index)
                .or_else(|| self.sessions.last())
                .map(|session| session.tab.id.clone());
        }
        Ok(())
    }

    pub fn list(&self, thread_id: Option<&str>) -> Vec<TerminalTab> {
        self.sessions
            .iter()
            .filter(|session| thread_id.is_none_or(|id| session.tab.thread_id == id))
            .map(TerminalSession::snapshot)
            .collect()
    }

    pub fn replay(&self, id: &str) -> Result<TerminalBuffer, TerminalError> {
        let session = self.session(id).ok_or(TerminalError::UnknownSession)?;
        Ok(TerminalBuffer {
            data: session.replay.iter().copied().collect(),
            at: session.written,
        })
    }

    pub fn request_replay(&self, id: &str) -> Result<(), TerminalError> {
        let session = self.session(id).ok_or(TerminalError::UnknownSession)?;
        self.dispatch(TerminalCommand::Replay {
            id: id.to_owned(),
            after: session.written,
        })
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), TerminalError> {
        if data.len() > MAX_TERMINAL_INPUT {
            return Err(TerminalError::InvalidRequest("input"));
        }
        let session = self.session(id).ok_or(TerminalError::UnknownSession)?;
        if !session.tab.running {
            return Ok(());
        }
        self.dispatch(TerminalCommand::Write {
            id: id.to_owned(),
            data: data.to_vec(),
        })
    }

    pub fn resize(&mut self, id: &str, columns: u16, rows: u16) -> Result<(), TerminalError> {
        validate_size(columns, "columns")?;
        validate_size(rows, "rows")?;
        let session = self.session_mut(id).ok_or(TerminalError::UnknownSession)?;
        session.screen.resize(columns, rows);
        session.tab.columns = columns;
        session.tab.rows = rows;
        self.dispatch(TerminalCommand::Resize {
            id: id.to_owned(),
            columns,
            rows,
        })
    }

    pub fn stop(&mut self, id: &str) -> Result<(), TerminalError> {
        let session = self.session(id).ok_or(TerminalError::UnknownSession)?;
        if !session.tab.running {
            return Ok(());
        }
        self.dispatch(TerminalCommand::Close { id: id.to_owned() })
    }

    pub fn apply_event(&mut self, event: TerminalEvent) -> Result<(), TerminalError> {
        event.validate()?;
        let id = match &event {
            TerminalEvent::Spawned { id }
            | TerminalEvent::Output { id, .. }
            | TerminalEvent::Replay { id, .. }
            | TerminalEvent::Exited { id, .. }
            | TerminalEvent::Error { id, .. } => id.clone(),
        };
        let session = self.session_mut(&id).ok_or(TerminalError::UnknownSession)?;
        match event {
            TerminalEvent::Spawned { .. } => {
                session.tab.lifecycle = TerminalLifecycle::Ready;
                session.tab.error = None;
            }
            TerminalEvent::Output { data, at, .. } | TerminalEvent::Replay { data, at, .. } => {
                session.append_output(&data, Some(at));
                if session.tab.lifecycle == TerminalLifecycle::Loading {
                    session.tab.lifecycle = TerminalLifecycle::Ready;
                }
            }
            TerminalEvent::Exited { code, .. } => {
                if !session.tab.running {
                    return Ok(());
                }
                let marker = if let Some(code) = code.filter(|code| *code != 0) {
                    format!("\r\n[session ended — exit {code}]\r\n")
                } else {
                    "\r\n[session ended]\r\n".to_owned()
                };
                session.append_output(marker.as_bytes(), None);
                session.tab.running = false;
                session.tab.exit_code = code;
                session.tab.lifecycle = TerminalLifecycle::Exited(code);
            }
            TerminalEvent::Error { message, .. } => {
                if !session.tab.running {
                    return Ok(());
                }
                let message = bounded_text(&message, MAX_TERMINAL_TITLE_BYTES);
                let marker = format!("\r\n[terminal could not start: {message}]\r\n");
                session.append_output(marker.as_bytes(), None);
                session.tab.running = false;
                session.tab.lifecycle = TerminalLifecycle::Error;
                session.tab.error = Some(message);
            }
        }
        Ok(())
    }

    pub fn poll_events(&mut self) -> usize {
        let mut count = 0;
        loop {
            let event = self
                .transport
                .as_ref()
                .and_then(|transport| transport.try_recv());
            let Some(event) = event else {
                break;
            };
            let _ = self.apply_event(event);
            count += 1;
        }
        count
    }

    pub fn screen(&self, id: &str) -> Option<&AnsiScreen> {
        self.session(id).map(|session| &session.screen)
    }

    pub fn screen_mut(&mut self, id: &str) -> Option<&mut AnsiScreen> {
        self.session_mut(id).map(|session| &mut session.screen)
    }

    pub fn begin_selection(&mut self, id: &str, point: TerminalPoint) -> Result<(), TerminalError> {
        self.screen_mut(id)
            .ok_or(TerminalError::UnknownSession)?
            .begin_selection(point);
        Ok(())
    }

    pub fn update_selection(
        &mut self,
        id: &str,
        point: TerminalPoint,
    ) -> Result<(), TerminalError> {
        self.screen_mut(id)
            .ok_or(TerminalError::UnknownSession)?
            .update_selection(point);
        Ok(())
    }

    pub fn clear_selection(&mut self, id: &str) -> Result<(), TerminalError> {
        self.screen_mut(id)
            .ok_or(TerminalError::UnknownSession)?
            .clear_selection();
        Ok(())
    }

    pub fn copy_selection(&self, id: &str) -> Result<Option<TerminalSelection>, TerminalError> {
        Ok(self
            .screen(id)
            .ok_or(TerminalError::UnknownSession)?
            .selection())
    }

    pub fn link_at(&self, id: &str, point: TerminalPoint) -> Result<Option<String>, TerminalError> {
        Ok(self
            .screen(id)
            .ok_or(TerminalError::UnknownSession)?
            .link_at(point))
    }

    pub fn set_composition(&mut self, id: &str, value: &str) -> Result<(), TerminalError> {
        if value.len() > MAX_TERMINAL_INPUT {
            return Err(TerminalError::InvalidRequest("composition"));
        }
        let session = self.session_mut(id).ok_or(TerminalError::UnknownSession)?;
        session.composition = value.to_owned();
        Ok(())
    }

    pub fn composition(&self, id: &str) -> Option<&str> {
        self.session(id).map(|session| session.composition.as_str())
    }

    pub fn commit_text(&mut self, id: &str, value: &str) -> Result<(), TerminalError> {
        if value.len() > MAX_TERMINAL_INPUT {
            return Err(TerminalError::InvalidRequest("text"));
        }
        if let Some(session) = self.session_mut(id) {
            session.composition.clear();
        } else {
            return Err(TerminalError::UnknownSession);
        }
        self.write(id, value.as_bytes())
    }

    pub fn handle_key(&mut self, id: &str, key: TerminalKey) -> Result<bool, TerminalError> {
        if matches!(key, TerminalKey::Copy) {
            return Ok(false);
        }
        let Some(data) = key.encode() else {
            return Ok(false);
        };
        self.write(id, &data)?;
        Ok(true)
    }

    fn new_id(&mut self) -> String {
        loop {
            let id = format!("terminal-{}", self.next_id);
            self.next_id = self.next_id.saturating_add(1);
            if !self.sessions.iter().any(|session| session.tab.id == id) {
                return id;
            }
        }
    }

    fn session(&self, id: &str) -> Option<&TerminalSession> {
        self.sessions.iter().find(|session| session.tab.id == id)
    }

    fn session_mut(&mut self, id: &str) -> Option<&mut TerminalSession> {
        self.sessions
            .iter_mut()
            .find(|session| session.tab.id == id)
    }

    fn dispatch(&self, command: TerminalCommand) -> Result<(), TerminalError> {
        self.transport
            .as_ref()
            .ok_or(TerminalError::TransportClosed)?
            .send(command)
    }
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct TerminalModifiers {
    pub control: bool,
    pub alt: bool,
    pub shift: bool,
    pub platform: bool,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalKey {
    Text(String),
    AltText(String),
    Control(u8),
    Enter,
    Tab,
    BackTab,
    Backspace,
    Escape,
    Delete,
    Up,
    Down,
    Left,
    Right,
    Home,
    End,
    PageUp,
    PageDown,
    Copy,
    Interrupt,
}

impl TerminalKey {
    pub fn from_gpui(
        key: &str,
        key_char: Option<&str>,
        modifiers: TerminalModifiers,
    ) -> Option<Self> {
        if modifiers.platform && !modifiers.control && key.eq_ignore_ascii_case("c") {
            return Some(Self::Copy);
        }
        if modifiers.control && key.eq_ignore_ascii_case("c") {
            return Some(Self::Interrupt);
        }
        if modifiers.control
            && !modifiers.alt
            && key.len() == 1
            && let Some(character) = key.chars().next()
        {
            if character.is_ascii_lowercase() {
                return Some(Self::Control(character as u8 - b'a' + 1));
            }
            if character.is_ascii_uppercase() {
                return Some(Self::Control(character as u8 - b'A' + 1));
            }
        }
        match key.to_ascii_lowercase().as_str() {
            "enter" | "return" => Some(Self::Enter),
            "tab" if modifiers.shift => Some(Self::BackTab),
            "tab" => Some(Self::Tab),
            "backspace" => Some(Self::Backspace),
            "escape" | "esc" => Some(Self::Escape),
            "delete" | "forwarddelete" => Some(Self::Delete),
            "up" => Some(Self::Up),
            "down" => Some(Self::Down),
            "left" => Some(Self::Left),
            "right" => Some(Self::Right),
            "home" => Some(Self::Home),
            "end" => Some(Self::End),
            "pageup" => Some(Self::PageUp),
            "pagedown" => Some(Self::PageDown),
            _ if !modifiers.control && !modifiers.platform => {
                let value = key_char.or_else(|| (!key.is_empty()).then_some(key))?;
                Some(if modifiers.alt {
                    Self::AltText(value.to_owned())
                } else {
                    Self::Text(value.to_owned())
                })
            }
            _ => None,
        }
    }

    fn encode(&self) -> Option<Vec<u8>> {
        Some(match self {
            Self::Text(value) => {
                if value.len() > MAX_TERMINAL_INPUT {
                    return None;
                }
                value.as_bytes().to_vec()
            }
            Self::AltText(value) => {
                if value.len() + 1 > MAX_TERMINAL_INPUT {
                    return None;
                }
                let mut data = Vec::with_capacity(value.len() + 1);
                data.push(0x1b);
                data.extend_from_slice(value.as_bytes());
                data
            }
            Self::Control(value) => vec![*value],
            Self::Enter => b"\r".to_vec(),
            Self::BackTab => b"\x1b[Z".to_vec(),
            Self::Tab => b"\t".to_vec(),
            Self::Backspace => b"\x7f".to_vec(),
            Self::Escape => b"\x1b".to_vec(),
            Self::Delete => b"\x1b[3~".to_vec(),
            Self::Up => b"\x1b[A".to_vec(),
            Self::Down => b"\x1b[B".to_vec(),
            Self::Left => b"\x1b[D".to_vec(),
            Self::Right => b"\x1b[C".to_vec(),
            Self::Home => b"\x1b[H".to_vec(),
            Self::End => b"\x1b[F".to_vec(),
            Self::PageUp => b"\x1b[5~".to_vec(),
            Self::PageDown => b"\x1b[6~".to_vec(),
            Self::Interrupt => vec![3],
            Self::Copy => return None,
        })
    }
}

pub fn terminal_title(cwd: &str) -> String {
    let trimmed = cwd.trim_end_matches(['/', '\\']);
    let title = trimmed.rsplit(['/', '\\']).next().unwrap_or_default();
    if !title.is_empty() && title.len() <= 40 {
        title.to_owned()
    } else {
        "shell".to_owned()
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum TerminalSurfaceAction {
    Hide,
    Pop(String),
    Selection(TerminalSelection),
    OpenLink { url: String, in_emma: bool },
}

pub type TerminalSurfaceCallback = Rc<dyn Fn(TerminalSurfaceAction)>;

#[derive(Clone, Debug, PartialEq)]
struct TerminalLinkMenu {
    url: String,
    left: f32,
    top: f32,
}

pub struct TerminalSurface {
    focus_handle: FocusHandle,
    controller: TerminalController,
    thread_id: Option<String>,
    callback: Option<TerminalSurfaceCallback>,
    error: Option<String>,
    bounds: Rc<Cell<Option<Bounds<gpui::Pixels>>>>,
    link: Option<TerminalLinkMenu>,
}

impl TerminalSurface {
    pub fn new(cx: &mut Context<Self>) -> Self {
        Self::with_transport(cx, None)
    }

    pub fn with_transport(
        cx: &mut Context<Self>,
        transport: Option<Arc<dyn TerminalTransport>>,
    ) -> Self {
        Self {
            focus_handle: cx.focus_handle(),
            controller: TerminalController::new(transport),
            thread_id: None,
            callback: None,
            error: None,
            bounds: Rc::new(Cell::new(None)),
            link: None,
        }
    }

    pub fn set_callback(&mut self, callback: impl Fn(TerminalSurfaceAction) + 'static) {
        self.callback = Some(Rc::new(callback));
    }

    pub fn controller(&self) -> &TerminalController {
        &self.controller
    }

    pub fn controller_mut(&mut self) -> &mut TerminalController {
        &mut self.controller
    }

    pub fn set_thread(&mut self, thread_id: Option<String>) {
        self.thread_id = thread_id;
        let visible = self.controller.list(self.thread_id.as_deref());
        if !visible
            .iter()
            .any(|tab| self.controller.active_id() == Some(tab.id.as_str()))
            && let Some(tab) = visible.first()
        {
            let _ = self.controller.select(&tab.id);
        }
    }

    pub fn thread_id(&self) -> Option<&str> {
        self.thread_id.as_deref()
    }

    pub fn focus(&self, window: &mut Window, cx: &mut App) {
        window.focus(&self.focus_handle, cx);
    }

    pub fn poll_events(&mut self) -> usize {
        self.controller.poll_events()
    }

    pub fn open(&mut self, request: TerminalOpen) -> Result<TerminalTab, TerminalError> {
        self.controller.open(request)
    }

    pub fn select(&mut self, id: &str) -> Result<(), TerminalError> {
        self.controller.select(id)
    }

    pub fn write(&self, id: &str, data: &[u8]) -> Result<(), TerminalError> {
        self.controller.write(id, data)
    }

    pub fn resize(&mut self, id: &str, columns: u16, rows: u16) -> Result<(), TerminalError> {
        self.controller.resize(id, columns, rows)
    }

    pub fn close(&mut self, id: &str) -> Result<(), TerminalError> {
        self.controller.close(id)
    }

    pub fn commit_text(&mut self, id: &str, value: &str) -> Result<(), TerminalError> {
        self.controller.commit_text(id, value)
    }

    pub fn copy_selection(&self, id: &str) -> Result<Option<TerminalSelection>, TerminalError> {
        self.controller.copy_selection(id)
    }

    fn fit_active_terminal(&mut self) {
        let Some(bounds) = self.bounds.get() else {
            return;
        };
        let Some(tab) = self.active_tab() else {
            return;
        };
        let (columns, rows) = terminal_grid_size(bounds);
        if (columns, rows) != (tab.columns, tab.rows)
            && let Err(error) = self.controller.resize(&tab.id, columns, rows)
        {
            self.error = Some(error.to_string());
        }
    }

    fn active_tab(&self) -> Option<TerminalTab> {
        let tabs = self.controller.list(self.thread_id.as_deref());
        let active = self.controller.active_id();
        tabs.iter()
            .find(|tab| Some(tab.id.as_str()) == active)
            .cloned()
            .or_else(|| tabs.into_iter().next())
    }

    fn render_tabs(&self, theme: &EmmaTheme, cx: &mut Context<Self>) -> AnyElement {
        let tabs = self.controller.list(self.thread_id.as_deref());
        let selected_id = self.active_tab().map(|tab| tab.id);
        let mut bar = h_flex()
            .id("terminal-tabs")
            .role(Role::TabList)
            .aria_label("Terminal sessions")
            .h(px(TERMINAL_TAB_HEIGHT))
            .w_full()
            .items_center()
            .bg(theme.colors.chrome)
            .border_b_1()
            .border_color(theme.colors.border);
        for tab in tabs {
            let selected = selected_id.as_deref() == Some(tab.id.as_str());
            let tab_id = tab.id.clone();
            let pop_id = tab.id.clone();
            let close_id = tab.id.clone();
            let callback = self.callback.clone();
            let label = if tab.running {
                tab.title.clone()
            } else {
                format!("{} · ended", tab.title)
            };
            let select = Button::new(format!("terminal-select-{tab_id}"))
                .ghost()
                .small()
                .selected(selected)
                .role(Role::Tab)
                .accessibility_label(label.clone())
                .h_full()
                .max_w(px(192.))
                .px(theme.spacing.s3)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_xs)
                .text_color(if selected {
                    theme.colors.text
                } else {
                    theme.colors.text_3
                })
                .when(selected, |element| element.bg(theme.colors.surface_3))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |this, _, _, cx| {
                        let _ = this.controller.select(&tab_id);
                        this.error = None;
                        cx.notify();
                    }),
                )
                .label(label);
            let pop_label = format!("Pop {} out", tab.title);
            let close_label = format!("Close {}", tab.title);
            let item = h_flex()
                .id(format!("terminal-tab-group-{}", tab.id))
                .h_full()
                .max_w(px(260.))
                .flex_none()
                .items_center()
                .border_r_1()
                .border_color(theme.colors.border)
                .when(selected, |element| element.bg(theme.colors.surface_3))
                .child(select)
                .child(
                    Button::new(format!("terminal-pop-{pop_id}"))
                        .ghost()
                        .small()
                        .h(px(18.))
                        .w(px(18.))
                        .p_0()
                        .label("⇱")
                        .accessibility_label(pop_label)
                        .on_click(move |_, _, _| {
                            if let Some(callback) = callback.as_ref() {
                                callback(TerminalSurfaceAction::Pop(pop_id.clone()));
                            }
                        }),
                )
                .child(
                    Button::new(format!("terminal-close-{close_id}"))
                        .ghost()
                        .small()
                        .h(px(18.))
                        .w(px(18.))
                        .mr(theme.spacing.s2)
                        .p_0()
                        .label("×")
                        .accessibility_label(close_label)
                        .on_click(cx.listener(move |this, _, _, cx| {
                            if let Err(error) = this.controller.close(&close_id) {
                                this.error = Some(error.to_string());
                            } else {
                                this.error = None;
                            }
                            cx.notify();
                        })),
                );
            bar = bar.child(item);
        }
        let thread_id = self.thread_id.clone();
        let cwd = self
            .active_tab()
            .map(|tab| tab.cwd)
            .or_else(|| {
                env::current_dir()
                    .ok()
                    .map(|path| path.to_string_lossy().into_owned())
            })
            .unwrap_or_else(|| "/".to_owned());
        let callback = self.callback.clone();
        bar = bar
            .child(
                Button::new("terminal-add")
                    .ghost()
                    .small()
                    .h_full()
                    .w(px(26.))
                    .p_0()
                    .label("+")
                    .accessibility_label("New terminal")
                    .disabled(thread_id.is_none())
                    .on_click(cx.listener(move |this, _, _, cx| {
                        let Some(thread_id) = thread_id.clone() else {
                            return;
                        };
                        match this
                            .controller
                            .open(TerminalOpen::new(thread_id, cwd.clone()))
                        {
                            Ok(_) => this.error = None,
                            Err(error) => this.error = Some(error.to_string()),
                        }
                        cx.notify();
                    })),
            )
            .child(div().flex_1())
            .child(
                Button::new("terminal-hide")
                    .ghost()
                    .small()
                    .h(px(22.))
                    .w(px(22.))
                    .p_0()
                    .mr(theme.spacing.s2)
                    .label("×")
                    .accessibility_label("Hide the terminal")
                    .on_click(move |_, _, _| {
                        if let Some(callback) = callback.as_ref() {
                            callback(TerminalSurfaceAction::Hide);
                        }
                    }),
            );
        bar.into_any_element()
    }

    fn render_screen(&self, theme: &EmmaTheme, window: &Window) -> AnyElement {
        let Some(tab) = self.active_tab() else {
            return v_flex()
                .id("terminal-empty")
                .size_full()
                .items_center()
                .justify_center()
                .text_color(theme.colors.text_3)
                .font_family(theme.typography.font_mono.clone())
                .text_size(theme.typography.fs_sm)
                .child("No shell is running here.")
                .into_any_element();
        };
        let Some(screen) = self.controller.screen(&tab.id) else {
            return v_flex()
                .id("terminal-missing")
                .size_full()
                .into_any_element();
        };
        let lines = screen.visible_lines();
        let screen_text = screen.text();
        let mut text = String::new();
        let mut runs = Vec::new();
        let mut base_style = window.text_style();
        base_style.font_family = theme.typography.font_mono.clone();
        base_style.color = theme.colors.text;
        base_style.font_size = px(TERMINAL_FONT_SIZE).into();
        for (line_index, line) in lines.iter().enumerate() {
            if line_index > 0 {
                text.push('\n');
                runs.push(base_style.to_run(1));
            }
            for cell in &line.cells {
                let start = text.len();
                text.push_str(&cell.text);
                let len = text.len() - start;
                if len == 0 {
                    continue;
                }
                let mut style = base_style.clone();
                let foreground = if cell.style.inverse {
                    cell.style.background
                } else {
                    cell.style.foreground
                };
                let background = if cell.style.inverse {
                    cell.style.foreground
                } else {
                    cell.style.background
                };
                style.color = terminal_hsla(foreground, theme.colors.text);
                if cell.style.dim {
                    style.color = style.color.opacity(0.6);
                }
                style.background_color = match background {
                    TerminalColor::Default => None,
                    color => Some(terminal_hsla(color, theme.colors.bg)),
                };
                style.font_weight = if cell.style.bold {
                    FontWeight::BOLD
                } else {
                    FontWeight::NORMAL
                };
                style.font_style = if cell.style.italic {
                    FontStyle::Italic
                } else {
                    FontStyle::Normal
                };
                style.underline = cell.style.underline.then_some(UnderlineStyle {
                    thickness: px(1.),
                    color: None,
                    wavy: false,
                });
                runs.push(style.to_run(len));
            }
        }
        if text.is_empty() {
            text.push(' ');
            runs.push(base_style.to_run(1));
        }
        let styled = StyledText::new(text).with_runs(runs);
        let cursor = screen.cursor();
        let cursor_left = px(TERMINAL_LEFT_PADDING + cursor.column as f32 * TERMINAL_CELL_WIDTH);
        let cursor_top = px(TERMINAL_TOP_PADDING + cursor.line as f32 * TERMINAL_LINE_HEIGHT);
        let composition = self.controller.composition(&tab.id).unwrap_or_default();
        let mut root = v_flex()
            .id("terminal-screen")
            .role(Role::Log)
            .aria_label(screen_text)
            .relative()
            .size_full()
            .overflow_y_scroll()
            .px(px(TERMINAL_LEFT_PADDING))
            .pt(px(TERMINAL_TOP_PADDING))
            .font_family(theme.typography.font_mono.clone())
            .text_size(px(TERMINAL_FONT_SIZE))
            .line_height(px(TERMINAL_LINE_HEIGHT))
            .bg(theme.colors.bg)
            .text_color(theme.colors.text)
            .whitespace_nowrap()
            .child(styled);
        if composition.is_empty() {
            root = root.child(
                div()
                    .id("terminal-cursor")
                    .absolute()
                    .left(cursor_left)
                    .top(cursor_top)
                    .w(px(1.5))
                    .h(px(TERMINAL_LINE_HEIGHT))
                    .bg(theme.colors.accent),
            );
        } else {
            root = root.child(
                div()
                    .id("terminal-composition")
                    .absolute()
                    .left(cursor_left)
                    .top(cursor_top)
                    .h(px(TERMINAL_LINE_HEIGHT))
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(px(TERMINAL_FONT_SIZE))
                    .text_color(theme.colors.text)
                    .border_b_1()
                    .border_color(theme.colors.accent)
                    .child(composition.to_owned()),
            );
        }
        root.into_any_element()
    }
}

impl Focusable for TerminalSurface {
    fn focus_handle(&self, _cx: &App) -> FocusHandle {
        self.focus_handle.clone()
    }
}

impl EntityInputHandler for TerminalSurface {
    fn text_for_range(
        &mut self,
        range: Range<usize>,
        adjusted_range: &mut Option<Range<usize>>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<String> {
        let id = self.active_tab()?.id;
        let text = self.controller.composition(&id)?;
        let byte_range = utf16_byte_range(text, range);
        *adjusted_range =
            Some(utf16_range(&text[..byte_range.start])..utf16_range(&text[..byte_range.end]));
        Some(text[byte_range].to_owned())
    }

    fn selected_text_range(
        &mut self,
        _ignore_disabled_input: bool,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<UTF16Selection> {
        Some(UTF16Selection {
            range: 0..0,
            reversed: false,
        })
    }

    fn marked_text_range(
        &self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Range<usize>> {
        let id = self.active_tab()?.id;
        let text = self.controller.composition(&id)?;
        (!text.is_empty()).then(|| 0..utf16_range(text))
    }

    fn unmark_text(&mut self, _window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.active_tab().map(|tab| tab.id) else {
            return;
        };
        if self.controller.set_composition(&id, "").is_ok() {
            cx.notify();
        }
    }

    fn replace_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        text: &str,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.active_tab().map(|tab| tab.id) else {
            return;
        };
        match self.controller.commit_text(&id, text) {
            Ok(()) => self.error = None,
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }

    fn replace_and_mark_text_in_range(
        &mut self,
        _range: Option<Range<usize>>,
        new_text: &str,
        _new_selected_range: Option<Range<usize>>,
        _window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        let Some(id) = self.active_tab().map(|tab| tab.id) else {
            return;
        };
        match self.controller.set_composition(&id, new_text) {
            Ok(()) => self.error = None,
            Err(error) => self.error = Some(error.to_string()),
        }
        cx.notify();
    }

    fn bounds_for_range(
        &mut self,
        range: Range<usize>,
        element_bounds: Bounds<gpui::Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<Bounds<gpui::Pixels>> {
        let id = self.active_tab()?.id;
        let cursor = self.controller.screen(&id)?.cursor();
        Some(Bounds::new(
            point(
                element_bounds.left()
                    + px(TERMINAL_LEFT_PADDING)
                    + px((cursor.column as f32 + range.start as f32) * TERMINAL_CELL_WIDTH),
                element_bounds.top()
                    + px(TERMINAL_TAB_HEIGHT + TERMINAL_TOP_PADDING)
                    + px(cursor.line as f32 * TERMINAL_LINE_HEIGHT),
            ),
            size(px(TERMINAL_CELL_WIDTH), px(TERMINAL_LINE_HEIGHT)),
        ))
    }

    fn character_index_for_point(
        &mut self,
        _point: gpui::Point<gpui::Pixels>,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        Some(0)
    }

    fn text_length_utf16(
        &mut self,
        _window: &mut Window,
        _cx: &mut Context<Self>,
    ) -> Option<usize> {
        let id = self.active_tab()?.id;
        Some(utf16_range(self.controller.composition(&id)?))
    }
}

impl Render for TerminalSurface {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.poll_events();
        self.fit_active_terminal();
        let theme = EmmaTheme::global(cx).cloned().unwrap_or_default();
        let active_id = self.active_tab().map(|tab| tab.id);
        let key_id = active_id.clone();
        let mouse_down_id = active_id.clone();
        let mouse_move_id = active_id.clone();
        let mouse_up_id = active_id.clone();
        let mut root = v_flex()
            .id("terminal-surface")
            .role(Role::Group)
            .aria_label("Terminal")
            .relative()
            .size_full()
            .min_w(px(0.))
            .min_h(px(0.))
            .bg(theme.colors.bg)
            .track_focus(&self.focus_handle)
            .tab_index(0)
            .on_key_down(cx.listener(move |this, event: &gpui::KeyDownEvent, _, cx| {
                if event.keystroke.key.eq_ignore_ascii_case("escape") && this.link.take().is_some()
                {
                    cx.notify();
                    return;
                }
                let Some(id) = key_id.as_deref() else {
                    return;
                };
                let modifiers = TerminalModifiers {
                    control: event.keystroke.modifiers.control,
                    alt: event.keystroke.modifiers.alt,
                    shift: event.keystroke.modifiers.shift,
                    platform: event.keystroke.modifiers.platform,
                };
                let Some(key) = TerminalKey::from_gpui(
                    event.keystroke.key.as_str(),
                    event.keystroke.key_char.as_deref(),
                    modifiers,
                ) else {
                    return;
                };
                if matches!(key, TerminalKey::Text(_)) {
                    return;
                }
                if matches!(key, TerminalKey::Copy) {
                    if let Ok(Some(selection)) = this.controller.copy_selection(id) {
                        cx.write_to_clipboard(ClipboardItem::new_string(selection.text));
                    }
                    cx.notify();
                } else if this.controller.handle_key(id, key).is_ok() {
                    cx.notify();
                }
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseDownEvent, window, cx| {
                    let Some(id) = mouse_down_id.as_deref() else {
                        return;
                    };
                    let Some(bounds) = this.bounds.get() else {
                        return;
                    };
                    let Some(screen) = this.controller.screen(id) else {
                        return;
                    };
                    let Some(point) = terminal_point_at(bounds, event.position, screen) else {
                        return;
                    };
                    if (event.modifiers.platform || event.modifiers.control)
                        && let Some(url) = screen.link_at(point)
                    {
                        let width = (bounds.right() - bounds.left()).as_f32();
                        let height = (bounds.bottom() - bounds.top()).as_f32();
                        this.link = Some(TerminalLinkMenu {
                            url,
                            left: (event.position.x - bounds.left())
                                .as_f32()
                                .clamp(0., (width - 340.).max(0.)),
                            top: ((event.position.y - bounds.top()).as_f32() + 8.)
                                .clamp(TERMINAL_TAB_HEIGHT, (height - 92.).max(0.)),
                        });
                        cx.notify();
                        return;
                    }
                    this.link = None;
                    if let Some(screen) = this.controller.screen_mut(id) {
                        screen.begin_selection(point);
                    }
                    window.focus(&this.focus_handle, cx);
                    cx.notify();
                }),
            )
            .on_mouse_move(cx.listener(move |this, event: &MouseMoveEvent, _, cx| {
                if !event.dragging() {
                    return;
                }
                let Some(id) = mouse_move_id.as_deref() else {
                    return;
                };
                let Some(bounds) = this.bounds.get() else {
                    return;
                };
                let point = this
                    .controller
                    .screen(id)
                    .and_then(|screen| terminal_point_at(bounds, event.position, screen));
                if let Some(point) = point
                    && let Some(screen) = this.controller.screen_mut(id)
                {
                    screen.update_selection(point);
                    cx.notify();
                }
            }))
            .on_mouse_up(
                MouseButton::Left,
                cx.listener(move |this, event: &MouseUpEvent, _, cx| {
                    let Some(id) = mouse_up_id.as_deref() else {
                        return;
                    };
                    if let Some(bounds) = this.bounds.get() {
                        let point = this
                            .controller
                            .screen(id)
                            .and_then(|screen| terminal_point_at(bounds, event.position, screen));
                        if let Some(point) = point
                            && let Some(screen) = this.controller.screen_mut(id)
                        {
                            screen.update_selection(point);
                        }
                    }
                    if let Ok(Some(selection)) = this.controller.copy_selection(id)
                        && let Some(callback) = this.callback.as_ref()
                    {
                        callback(TerminalSurfaceAction::Selection(selection));
                    }
                    cx.notify();
                }),
            )
            .on_scroll_wheel(
                cx.listener(move |this, event: &gpui::ScrollWheelEvent, _, cx| {
                    let Some(id) = active_id.as_deref() else {
                        return;
                    };
                    let delta = match event.delta {
                        ScrollDelta::Lines(point) => point.y.round() as i32,
                        ScrollDelta::Pixels(point) => {
                            (point.y / px(TERMINAL_LINE_HEIGHT)).round() as i32
                        }
                    };
                    if let Some(screen) = this.controller.screen_mut(id) {
                        screen.scroll_by(delta);
                        cx.notify();
                    }
                }),
            )
            .child(self.render_tabs(&theme, cx))
            .child(self.render_screen(&theme, window))
            .child({
                let focus_handle = self.focus_handle.clone();
                let entity = cx.entity();
                let terminal_bounds = self.bounds.clone();
                canvas(
                    |_, _, _| (),
                    move |bounds, _, window, cx| {
                        terminal_bounds.set(Some(bounds));
                        window.handle_input(
                            &focus_handle,
                            ElementInputHandler::new(bounds, entity.clone()),
                            cx,
                        );
                    },
                )
                .absolute()
                .inset_0()
            });
        if let Some(tab) = self.active_tab() {
            let status = match tab.lifecycle {
                TerminalLifecycle::Loading => "Loading terminal…".to_owned(),
                TerminalLifecycle::Ready => String::new(),
                TerminalLifecycle::Exited(_) => "Session ended".to_owned(),
                TerminalLifecycle::Error => tab
                    .error
                    .clone()
                    .unwrap_or_else(|| "Terminal unavailable".to_owned()),
            };
            if !status.is_empty() {
                root = root.child(
                    div()
                        .id("terminal-status")
                        .absolute()
                        .left_0()
                        .right_0()
                        .bottom_0()
                        .px(theme.spacing.s3)
                        .py(theme.spacing.s1)
                        .text_color(if tab.lifecycle == TerminalLifecycle::Error {
                            theme.colors.danger
                        } else {
                            theme.colors.text_3
                        })
                        .bg(if tab.lifecycle == TerminalLifecycle::Error {
                            theme.colors.danger_surface
                        } else {
                            theme.colors.surface
                        })
                        .font_family(theme.typography.font_mono.clone())
                        .text_size(theme.typography.fs_xs)
                        .child(status),
                );
            }
        }
        if let Some(error) = self.error.as_ref() {
            root = root.child(
                div()
                    .id("terminal-error")
                    .role(Role::Alert)
                    .absolute()
                    .left_0()
                    .right_0()
                    .bottom_0()
                    .px(theme.spacing.s3)
                    .py(theme.spacing.s1)
                    .text_color(theme.colors.danger)
                    .bg(theme.colors.danger_surface)
                    .font_family(theme.typography.font_mono.clone())
                    .text_size(theme.typography.fs_xs)
                    .child(error.clone()),
            );
        }
        if let Some(link) = self.link.clone() {
            let emma_url = link.url.clone();
            let system_url = link.url.clone();
            let emma_callback = self.callback.clone();
            let system_callback = self.callback.clone();
            root = root.child(
                v_flex()
                    .id("terminal-link-menu")
                    .role(Role::Menu)
                    .aria_label("Open this link")
                    .absolute()
                    .left(px(link.left))
                    .top(px(link.top))
                    .w(px(340.))
                    .bg(theme.colors.surface)
                    .border_1()
                    .border_color(theme.colors.border_strong)
                    .child(
                        div()
                            .px(theme.spacing.s3)
                            .py(theme.spacing.s2)
                            .border_b_1()
                            .border_color(theme.colors.border)
                            .truncate()
                            .font_family(theme.typography.font_mono.clone())
                            .text_size(theme.typography.fs_2xs)
                            .text_color(theme.colors.text_3)
                            .child(link.url),
                    )
                    .child(
                        Button::new("terminal-link-emma")
                            .ghost()
                            .label("Emma's browser")
                            .accessibility_label("Open link in Emma's browser")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.link = None;
                                if let Some(callback) = emma_callback.as_ref() {
                                    callback(TerminalSurfaceAction::OpenLink {
                                        url: emma_url.clone(),
                                        in_emma: true,
                                    });
                                }
                                cx.notify();
                            })),
                    )
                    .child(
                        Button::new("terminal-link-system")
                            .ghost()
                            .label("Default browser")
                            .accessibility_label("Open link in the default browser")
                            .on_click(cx.listener(move |this, _, _, cx| {
                                this.link = None;
                                if let Some(callback) = system_callback.as_ref() {
                                    callback(TerminalSurfaceAction::OpenLink {
                                        url: system_url.clone(),
                                        in_emma: false,
                                    });
                                }
                                cx.notify();
                            })),
                    ),
            );
        }
        root
    }
}

fn terminal_point_at(
    bounds: Bounds<gpui::Pixels>,
    position: gpui::Point<gpui::Pixels>,
    screen: &AnsiScreen,
) -> Option<TerminalPoint> {
    let x = (position.x - bounds.left()).as_f32() - TERMINAL_LEFT_PADDING;
    let y = (position.y - bounds.top()).as_f32() - TERMINAL_TAB_HEIGHT - TERMINAL_TOP_PADDING;
    if y < 0. {
        return None;
    }
    let visible = screen.visible_lines();
    if visible.is_empty() {
        return None;
    }
    let line = (y / TERMINAL_LINE_HEIGHT).floor().max(0.) as usize;
    let column = (x.max(0.) / TERMINAL_CELL_WIDTH).floor() as usize;
    Some(TerminalPoint {
        line: screen.visible_start() + line.min(visible.len().saturating_sub(1)),
        column: column.min(usize::from(screen.columns())),
    })
}

fn terminal_grid_size(bounds: Bounds<gpui::Pixels>) -> (u16, u16) {
    let width = ((bounds.right() - bounds.left()).as_f32() - TERMINAL_LEFT_PADDING).max(0.);
    let height =
        ((bounds.bottom() - bounds.top()).as_f32() - TERMINAL_TAB_HEIGHT - TERMINAL_TOP_PADDING)
            .max(0.);
    let columns = (width / TERMINAL_CELL_WIDTH)
        .floor()
        .clamp(1., f32::from(MAX_TERMINAL_COLUMNS)) as u16;
    let rows = (height / TERMINAL_LINE_HEIGHT)
        .floor()
        .clamp(1., f32::from(MAX_TERMINAL_ROWS)) as u16;
    (columns, rows)
}

fn utf16_range(text: &str) -> usize {
    text.encode_utf16().count()
}

fn utf16_byte_range(text: &str, range: Range<usize>) -> Range<usize> {
    let start = utf16_byte_offset(text, range.start, false);
    let end = utf16_byte_offset(text, range.end, true);
    start.min(end)..end
}

fn utf16_byte_offset(text: &str, target: usize, round_up: bool) -> usize {
    let mut offset = 0;
    for (index, character) in text.char_indices() {
        if target == offset {
            return index;
        }
        let next = offset + character.len_utf16();
        if target < next {
            return if round_up {
                index + character.len_utf8()
            } else {
                index
            };
        }
        if target == next {
            return index + character.len_utf8();
        }
        offset = next;
    }
    text.len()
}

fn terminal_hsla(color: TerminalColor, default: gpui::Hsla) -> gpui::Hsla {
    let (red, green, blue) = match color {
        TerminalColor::Default => return default,
        TerminalColor::Rgb(red, green, blue) => (red, green, blue),
        TerminalColor::Indexed(index) => ansi_palette(index),
    };
    gpui::Hsla::from(rgb((u32::from(red) << 16)
        | (u32::from(green) << 8)
        | u32::from(blue)))
}

fn ansi_palette(index: u8) -> (u8, u8, u8) {
    const COLORS: [(u8, u8, u8); 16] = [
        (14, 14, 16),
        (237, 122, 155),
        (195, 214, 75),
        (255, 106, 61),
        (111, 174, 230),
        (174, 120, 240),
        (63, 216, 192),
        (232, 230, 223),
        (78, 78, 86),
        (255, 145, 169),
        (213, 230, 97),
        (255, 145, 98),
        (137, 194, 244),
        (202, 159, 255),
        (105, 237, 217),
        (244, 242, 236),
    ];
    if usize::from(index) < COLORS.len() {
        return COLORS[usize::from(index)];
    }
    if index < 232 {
        let index = index - 16;
        let red = index / 36;
        let green = (index / 6) % 6;
        let blue = index % 6;
        return (cube(red), cube(green), cube(blue));
    }
    let gray = 8 + (index - 232) * 10;
    (gray, gray, gray)
}

fn cube(value: u8) -> u8 {
    if value == 0 { 0 } else { 55 + value * 40 }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_ansi_cursor_and_sgr() {
        let mut screen = AnsiScreen::new(12, 3);
        screen.feed(b"one\x1b[2J\x1b[2;3H\x1b[31mred\x1b[0m");
        assert_eq!(screen.text(), "\n  red\n");
        assert_eq!(
            screen.screen[1].cells[2].style.foreground,
            TerminalColor::Indexed(1)
        );
    }

    #[test]
    fn split_utf8_and_osc_title_are_retained() {
        let mut screen = AnsiScreen::new(12, 3);
        screen.feed(b"caf\xc3");
        screen.feed(b"\xa9\x1b]2;Emma\x07ok");
        assert!(screen.text().contains("café"));
        assert_eq!(screen.title(), "Emma");
    }

    #[test]
    fn replay_is_bounded_and_offsets_are_deduplicated() {
        let mut session =
            TerminalSession::new("terminal-1".to_owned(), &TerminalOpen::new("t", "/tmp"));
        let output = vec![b'x'; MAX_TERMINAL_SCROLLBACK + 16];
        for chunk in output.chunks(MAX_TERMINAL_EVENT_BYTES) {
            session.append_output(chunk, None);
        }
        assert_eq!(session.replay_bytes, MAX_TERMINAL_SCROLLBACK);
        session.append_output(b"yz", Some(session.written + 2));
        assert_eq!(session.written, (MAX_TERMINAL_SCROLLBACK + 18) as u64);
        session.append_output(b"bad-offset", Some(1));
        assert_eq!(session.written, (MAX_TERMINAL_SCROLLBACK + 18) as u64);
        session.append_output(&[b'q'; 32], Some(session.written + 5));
        assert_eq!(session.written, (MAX_TERMINAL_SCROLLBACK + 23) as u64);
    }

    #[test]
    fn selection_matches_electron_limits() {
        let mut screen = AnsiScreen::new(8, 2);
        screen.feed(b"one\r\ntwo\r\nthree");
        screen.begin_selection(TerminalPoint { line: 0, column: 0 });
        screen.update_selection(TerminalPoint { line: 2, column: 5 });
        let selection = screen.selection().unwrap();
        assert_eq!(selection.text, "one\ntwo\nthree");
        assert_eq!(selection.lines, 3);
    }

    #[test]
    fn helper_contract_and_key_sequences_are_bounded() {
        let request = TerminalOpen::new("thread", "/tmp");
        let spawn = PtySpawn::from_request("terminal-1".to_owned(), &request).unwrap();
        assert_eq!(spawn.helper_arguments()[..2], ["80", "24"]);
        let mut cli_request = TerminalOpen::new("thread", "/tmp");
        cli_request.cli = Some("codex".to_owned());
        let cli_spawn = PtySpawn::from_request("terminal-2".to_owned(), &cli_request).unwrap();
        #[cfg(not(windows))]
        {
            assert_eq!(cli_spawn.argv[1], "-ilc");
            assert_eq!(cli_spawn.argv[2], "codex");
        }
        #[cfg(windows)]
        {
            assert_eq!(cli_spawn.argv[1], "/d");
            assert_eq!(cli_spawn.argv[2], "/s");
            assert_eq!(cli_spawn.argv[3], "/c");
            assert_eq!(cli_spawn.argv[4], "codex");
        }
        assert_eq!(
            TerminalSession::new("terminal-2".to_owned(), &cli_request)
                .snapshot()
                .title,
            "Codex"
        );
        let mut unknown = TerminalOpen::new("thread", "/tmp");
        unknown.cli = Some("unknown".to_owned());
        assert!(matches!(
            PtySpawn::from_request("terminal-3".to_owned(), &unknown),
            Err(TerminalError::InvalidRequest("cli"))
        ));
        assert_eq!(PtySpawn::resize_line(100, 40).unwrap(), "100 40\n");
        assert_eq!(TerminalKey::Up.encode().unwrap(), b"\x1b[A");
        assert_eq!(TerminalKey::Interrupt.encode().unwrap(), [3]);
        assert_eq!(
            TerminalKey::from_gpui(
                "c",
                Some("c"),
                TerminalModifiers {
                    platform: true,
                    ..TerminalModifiers::default()
                }
            ),
            Some(TerminalKey::Copy)
        );
        assert_eq!(
            TerminalKey::from_gpui(
                "c",
                Some("c"),
                TerminalModifiers {
                    control: true,
                    ..TerminalModifiers::default()
                }
            ),
            Some(TerminalKey::Interrupt)
        );
        assert_eq!(TerminalKey::Control(4).encode().unwrap(), [4]);
        assert_eq!(TerminalKey::BackTab.encode().unwrap(), b"\x1b[Z");
    }

    #[test]
    fn utf16_ranges_keep_ime_text_on_scalar_boundaries() {
        let text = "a🦀b";
        assert_eq!(&text[utf16_byte_range(text, 1..3)], "🦀");
        assert_eq!(&text[utf16_byte_range(text, 2..2)], "🦀");
        assert_eq!(&text[utf16_byte_range(text, 3..4)], "b");
        assert_eq!(utf16_range(text), 4);
    }

    #[test]
    fn pointer_coordinates_exclude_tabs_and_follow_scrollback() {
        let mut screen = AnsiScreen::new(10, 2);
        screen.feed(b"one\r\ntwo\r\nthree");
        let bounds = Bounds::new(point(px(100.), px(200.)), size(px(300.), px(180.)));
        assert_eq!(
            terminal_point_at(bounds, point(px(108.), px(220.)), &screen),
            None
        );
        assert_eq!(
            terminal_point_at(bounds, point(px(116.), px(246.)), &screen),
            Some(TerminalPoint { line: 1, column: 1 })
        );
        assert_eq!(terminal_grid_size(bounds), (40, 8));
    }

    #[test]
    fn controller_keeps_tabs_replay_and_worker_commands_correlated() {
        let (transport, worker) = ChannelTerminalTransport::channel(16).unwrap();
        let mut controller = TerminalController::new(Some(transport));
        let tab = controller
            .open(TerminalOpen::new("thread", "/tmp"))
            .unwrap();
        assert_eq!(tab.lifecycle, TerminalLifecycle::Loading);
        let command = worker.try_recv().unwrap();
        assert!(matches!(command, TerminalCommand::Spawn(_)));
        worker
            .send_event(TerminalEvent::Spawned { id: tab.id.clone() })
            .unwrap();
        worker
            .send_event(TerminalEvent::Output {
                id: tab.id.clone(),
                data: b"ready".to_vec(),
                at: 5,
            })
            .unwrap();
        assert_eq!(controller.poll_events(), 2);
        assert_eq!(
            controller.list(Some("thread"))[0].lifecycle,
            TerminalLifecycle::Ready
        );
        assert_eq!(controller.replay(&tab.id).unwrap().data, b"ready");
        controller.write(&tab.id, b"x").unwrap();
        assert!(matches!(
            worker.try_recv(),
            Some(TerminalCommand::Write { .. })
        ));
        controller.resize(&tab.id, 100, 40).unwrap();
        assert!(matches!(
            worker.try_recv(),
            Some(TerminalCommand::Resize { .. })
        ));
    }

    #[test]
    fn controller_uses_exact_terminal_end_markers() {
        let (transport, worker) = ChannelTerminalTransport::channel(8).unwrap();
        let mut controller = TerminalController::new(Some(transport));
        let tab = controller
            .open(TerminalOpen::new("thread", "/tmp"))
            .unwrap();
        let _ = worker.try_recv();
        worker
            .send_event(TerminalEvent::Exited {
                id: tab.id.clone(),
                code: Some(0),
            })
            .unwrap();
        controller.poll_events();
        let text = controller.screen(&tab.id).unwrap().text();
        assert!(text.starts_with("\n[session ended]\n"));
        assert!(!text.contains("exit 0"));
    }

    #[test]
    fn selection_reports_dropped_lines_like_the_renderer_contract() {
        let mut screen = AnsiScreen::new(4, 1);
        let output = (0..MAX_TERMINAL_SELECTION_LINES + 3)
            .map(|index| format!("{index}\r\n"))
            .collect::<String>();
        screen.feed(output.as_bytes());
        screen.begin_selection(TerminalPoint { line: 0, column: 0 });
        screen.update_selection(TerminalPoint {
            line: MAX_TERMINAL_SELECTION_LINES + 2,
            column: 1,
        });
        let selection = screen.selection().unwrap();
        assert_eq!(selection.lines, MAX_TERMINAL_SELECTION_LINES + 3);
        assert!(selection.text.ends_with("[3 more lines not attached]"));
    }

    #[test]
    fn channel_transport_is_bounded() {
        let (transport, worker) = ChannelTerminalTransport::channel(1).unwrap();
        assert!(matches!(
            transport.send(TerminalCommand::Write {
                id: "terminal-1".to_owned(),
                data: vec![0; MAX_TERMINAL_INPUT + 1],
            }),
            Err(TerminalError::InvalidRequest("input"))
        ));
        assert!(matches!(
            worker.send_event(TerminalEvent::Output {
                id: "terminal-1".to_owned(),
                data: vec![0; MAX_TERMINAL_EVENT_BYTES + 1],
                at: 1,
            }),
            Err(TerminalError::InvalidRequest("output"))
        ));
        transport
            .send(TerminalCommand::Close {
                id: "terminal-1".to_owned(),
            })
            .unwrap();
        assert!(matches!(
            transport.send(TerminalCommand::Close {
                id: "terminal-2".to_owned(),
            }),
            Err(TerminalError::QueueFull)
        ));
        assert!(matches!(
            worker.try_recv(),
            Some(TerminalCommand::Close { .. })
        ));
    }
}
