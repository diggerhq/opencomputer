//! The live area, laid out into screen rows: what is still changing, the
//! open ask, the pinned lines, a list, the rule, the prompt line and the
//! status line. Pure: [`compose`] gives rows, which [`super::draw`] writes
//! inline and [`to_lines`] turns into ratatui lines (for tests on
//! `TestBackend`).

use ratatui::style::{Modifier, Style};
use ratatui::text::{Line, Span};

use super::model::RIGHT;
use super::{Seg, Sty, TLine, char_width, g, truncate, width};

/// The live area never takes more than this many rows, or half the screen.
pub const MAX_LIVE: usize = 12;

/// One row on screen, never wider than the width it was made for.
pub type Row = Vec<Seg>;

/// Breaks a line into rows of at most `w` columns: prose wraps at spaces
/// with a hanging indent, `nowrap` lines are cut with `…`, and a segment
/// marked [`RIGHT`] goes flush right on the first row.
pub fn wrap(l: &TLine, w: usize) -> Vec<Row> {
    let w = w.max(1);
    let right: Option<&Seg> = l.segs.iter().find(|s| s.link.as_deref() == Some(RIGHT));
    let segs: Vec<&Seg> = l.segs.iter().filter(|s| s.link.as_deref() != Some(RIGHT)).collect();
    let lead = l.lead.min(w.saturating_sub(1));
    if l.nowrap || right.is_some() {
        let rw = right.map(|r| width(&r.text) + 2).unwrap_or(0);
        let room = w.saturating_sub(lead);
        let (room, show_right) = if rw > 0 && room > rw + 8 { (room - rw, true) } else { (room, false) };
        let mut row: Row = Vec::new();
        if lead > 0 {
            row.push(Seg::new(" ".repeat(lead), Sty::Plain));
        }
        let mut used = 0;
        for s in segs {
            if used >= room {
                break;
            }
            let t = s.text.replace('\n', " ");
            let tw = width(&t);
            let t = if used + tw > room { truncate(&t, room - used) } else { t };
            used += width(&t);
            row.push(Seg { text: t, sty: s.sty, link: s.link.clone() });
        }
        if show_right && let Some(r) = right {
            row.push(Seg::new(" ".repeat(room - used + 2), Sty::Plain));
            row.push(Seg::new(r.text.clone(), r.sty));
        }
        return vec![row];
    }
    // Prose: words across segments, wrapped at spaces.
    let indent = l.indent.min(w.saturating_sub(1));
    let mut rows: Vec<Row> = Vec::new();
    let mut row: Row = Vec::new();
    let mut col = lead;
    if lead > 0 {
        row.push(Seg::new(" ".repeat(lead), Sty::Plain));
    }
    let push = |row: &mut Row, text: &str, s: &Seg| {
        if let Some(last) = row.last_mut()
            && last.sty == s.sty
            && last.link == s.link
            && !last.text.chars().all(|c| c == ' ')
        {
            last.text.push_str(text);
        } else {
            row.push(Seg { text: text.to_string(), sty: s.sty, link: s.link.clone() });
        }
    };
    for s in segs {
        // Tokens: runs of spaces and runs of non-spaces.
        let mut tokens: Vec<String> = Vec::new();
        for c in s.text.chars() {
            let c = if c == '\n' || c == '\t' { ' ' } else { c };
            match tokens.last_mut() {
                Some(t) if (t.ends_with(' ')) == (c == ' ') => t.push(c),
                _ => tokens.push(c.to_string()),
            }
        }
        for t in tokens {
            let tw = width(&t);
            if t.starts_with(' ') {
                if col + tw <= w {
                    if col > indent || rows.is_empty() {
                        push(&mut row, &t, s);
                        col += tw;
                    }
                } else {
                    rows.push(std::mem::take(&mut row));
                    row.push(Seg::new(" ".repeat(indent), Sty::Plain));
                    col = indent;
                }
                continue;
            }
            if col + tw > w && col > indent {
                // Drop trailing spaces of the row before breaking.
                let n = row.len();
                if let Some(last) = row.last_mut() {
                    let trimmed = last.text.trim_end_matches(' ').to_string();
                    if trimmed.is_empty() && n > 1 {
                        row.pop();
                    } else {
                        last.text = trimmed;
                    }
                }
                rows.push(std::mem::take(&mut row));
                if indent > 0 {
                    row.push(Seg::new(" ".repeat(indent), Sty::Plain));
                }
                col = indent;
            }
            if col + tw <= w {
                push(&mut row, &t, s);
                col += tw;
                continue;
            }
            // A word longer than the row: break it by characters.
            let mut piece = String::new();
            for c in t.chars() {
                let cw = char_width(c);
                if col + cw > w {
                    push(&mut row, &piece, s);
                    piece.clear();
                    rows.push(std::mem::take(&mut row));
                    if indent > 0 {
                        row.push(Seg::new(" ".repeat(indent), Sty::Plain));
                    }
                    col = indent;
                }
                piece.push(c);
                col += cw;
            }
            if !piece.is_empty() {
                push(&mut row, &piece, s);
            }
        }
    }
    rows.push(row);
    rows
}

/// The width of a row.
pub fn row_width(r: &Row) -> usize {
    r.iter().map(|s| width(&s.text)).sum()
}

/// Everything the live area shows, gathered by the app.
#[derive(Debug, Clone, Default)]
pub struct Live {
    /// The model's changing lines: text, thinking, steps.
    pub top: Vec<TLine>,
    /// The ask, drawn under `top`; `ask_cursor` when it has the keyboard
    /// and a line in it is being typed in.
    pub ask: Vec<TLine>,
    pub ask_cursor: Option<(usize, usize)>,
    /// The ask has the keyboard: the prompt line's cursor is not shown.
    pub ask_focused: bool,
    /// Todo line, background subagents, queued messages.
    pub pinned: Vec<TLine>,
    /// A list (`/subagents`, a chooser, the picker) or a short notice.
    pub list: Vec<TLine>,
    pub prompt: Vec<TLine>,
    pub prompt_cursor: (usize, usize),
    pub status_left: Vec<Seg>,
    pub status_right: String,
}

/// Rows of the live area for a `w`×`h` terminal, and where the cursor goes.
pub fn compose(live: &Live, w: usize, h: usize) -> (Vec<Row>, (usize, usize)) {
    let w = w.max(1);
    let h = h.max(3);
    let wrap_all = |ls: &[TLine]| ls.iter().flat_map(|l| wrap(l, w)).collect::<Vec<Row>>();
    // The fixed bottom: rule, prompt (at most 6 rows around the cursor),
    // status. Never more than `h - 1` rows: on a short screen the prompt
    // shows fewer rows, then the status row goes.
    let cap = h - 1;
    let show_status = cap >= 3;
    let pmax = 6.min(cap - 1 - show_status as usize).max(1);
    let mut prompt = wrap_all(&live.prompt);
    let (mut pr, pc) = live.prompt_cursor;
    if prompt.len() > pmax {
        let start = pr.saturating_sub(pmax - 1).min(prompt.len() - pmax);
        prompt = prompt[start..start + pmax].to_vec();
        pr -= start;
    }
    let status = status_row(&live.status_left, &live.status_right, w);
    let fixed = prompt.len() + 1 + show_status as usize;
    let budget = MAX_LIVE.min(h / 2).max(fixed + 1);
    // The ask and a list are shown whole when the screen allows.
    let mut ask = wrap_all(&live.ask);
    let mut ask_cursor = live.ask_cursor;
    let mut list = wrap_all(&live.list);
    let room = cap.saturating_sub(fixed);
    if list.len() > room {
        list = list.split_off(list.len() - room);
    }
    let room = room - list.len();
    if ask.len() > room {
        let cut = ask.len() - room;
        ask = ask.split_off(cut);
        ask_cursor = ask_cursor.and_then(|(r, c)| r.checked_sub(cut).map(|r| (r, c)));
    }
    let used = fixed + ask.len() + list.len();
    let left = budget.max(used).min(cap).saturating_sub(used);
    let mut pinned = wrap_all(&live.pinned);
    if pinned.len() > left {
        pinned = pinned.split_off(pinned.len() - left);
    }
    let left = left - pinned.len();
    let mut top = wrap_all(&live.top);
    if top.len() > left {
        top = top.split_off(top.len() - left);
    }
    let mut rows = Vec::new();
    rows.extend(top);
    let ask_at = rows.len();
    rows.extend(ask);
    rows.extend(pinned);
    rows.extend(list);
    rows.push(vec![Seg::new(g().rule.repeat(w), Sty::Dim)]);
    let prompt_at = rows.len();
    rows.extend(prompt);
    if show_status {
        rows.push(status);
    }
    let cursor = match ask_cursor {
        Some((r, c)) if live.ask_focused => (ask_at + r, c.min(w - 1)),
        _ => (prompt_at + pr, pc.min(w - 1)),
    };
    (rows, cursor)
}

/// The status line: the left side, and the right side flush right when
/// there is room and the terminal is 40 columns or wider.
pub fn status_row(left: &[Seg], right: &str, w: usize) -> Row {
    let mut row: Row = Vec::new();
    let mut used = 0;
    for s in left {
        let room = w.saturating_sub(used);
        if room == 0 {
            break;
        }
        let t = truncate(&s.text, room);
        used += width(&t);
        row.push(Seg { text: t, sty: s.sty, link: None });
    }
    let rw = width(right);
    if w >= 40 && !right.is_empty() && used + rw + 2 <= w {
        row.push(Seg::new(" ".repeat(w - used - rw), Sty::Plain));
        row.push(Seg::new(right.to_string(), Sty::Dim));
    }
    row
}

/// The ratatui style of a meaning; `color` off keeps only bold and dim
/// where they carry meaning.
pub fn style(s: Sty, color: bool) -> Style {
    use ratatui::style::Color;
    let base = Style::default();
    if !color {
        return base;
    }
    match s {
        Sty::Plain => base,
        Sty::Dim => base.add_modifier(Modifier::DIM),
        Sty::Bold | Sty::Heading => base.add_modifier(Modifier::BOLD),
        Sty::Italic => base.add_modifier(Modifier::ITALIC),
        Sty::Code | Sty::Block => base.fg(Color::Cyan),
        Sty::Link => base.fg(Color::Blue).add_modifier(Modifier::UNDERLINED),
        Sty::Ok => base.fg(Color::Green),
        Sty::Err => base.fg(Color::Red),
        Sty::Warn => base.fg(Color::Yellow),
        Sty::Accent => base.fg(Color::Cyan),
        Sty::Me => base.fg(Color::Blue).add_modifier(Modifier::BOLD),
        Sty::Person => base.fg(Color::Magenta).add_modifier(Modifier::BOLD),
    }
}

/// Rows as ratatui lines.
pub fn to_lines(rows: &[Row], color: bool) -> Vec<Line<'static>> {
    rows.iter().map(|r| Line::from(r.iter().map(|s| Span::styled(s.text.clone(), style(s.sty, color))).collect::<Vec<_>>())).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::types::Event;
    use crate::ui::model::Model;
    use crate::ui::prompt::Editor;
    use ratatui::Terminal;
    use ratatui::backend::TestBackend;
    use ratatui::widgets::Paragraph;
    use serde_json::{Value, json};

    fn screen(rows: &[Row], w: u16, h: u16) -> Vec<String> {
        let mut t = Terminal::new(TestBackend::new(w, h)).unwrap();
        let lines = to_lines(rows, true);
        t.draw(|f| f.render_widget(Paragraph::new(lines), f.area())).unwrap();
        let buf = t.backend().buffer().clone();
        (0..h).map(|y| (0..w).map(|x| buf[(x, y)].symbol().to_string()).collect::<String>().trim_end().to_string()).collect()
    }

    fn ev(seq: u64, kind: &str, data: Value) -> Event {
        Event(json!({"seq": seq, "type": kind, "sessionId": "ses_7f3a", "turnId": "tn_1", "data": data}))
    }

    fn live_of(m: &Model, ed: &Editor, now: i64, w: usize) -> Live {
        let (top, pinned) = m.live(now);
        let (prompt, cur) = ed.render(w, "");
        let (l, r) = m.status(now);
        Live { top, pinned, prompt, prompt_cursor: cur, status_left: l, status_right: r, ..Default::default() }
    }

    #[test]
    fn prose_wraps_with_a_hanging_indent() {
        let l = TLine::new(6, 6).s("The test depends on timer order when the machine is busy.", Sty::Plain);
        let rows: Vec<String> = wrap(&l, 31).iter().map(|r| r.iter().map(|s| s.text.as_str()).collect()).collect();
        assert_eq!(rows, vec!["      The test depends on timer", "      order when the machine is", "      busy."]);
        let n = TLine::row(2).s("a very long step summary that does not fit", Sty::Plain);
        assert_eq!(wrap(&n, 20).len(), 1);
        assert_eq!(row_width(&wrap(&n, 20)[0]), 20);
    }

    #[test]
    fn a_running_turn_on_the_test_backend() {
        let mut m = Model::new("ses_7f3a", false);
        m.conn = crate::ui::model::Conn::Online;
        m.event(&ev(1, "turn.started", json!({})), 0);
        m.event(&ev(2, "tool.started", json!({"toolName": "Bash", "callId": "c1", "input": {"command": "npm test", "description": "Run the segment test 20 times"}})), 0);
        m.take_out();
        let ed = Editor::new(vec![]);
        let live = live_of(&m, &ed, 12_000, 70);
        let (rows, cursor) = compose(&live, 70, 24);
        let s = screen(&rows, 70, rows.len() as u16);
        assert!(s[0].starts_with("  ⠋ Bash  Run the segment test 20 times"), "{s:?}");
        assert!(s[0].ends_with("12 s"), "{s:?}");
        assert_eq!(s[1], "─".repeat(70));
        assert_eq!(s[2], ">");
        assert!(s[3].starts_with("● running"), "{s:?}");
        assert!(s[3].ends_with("ctrl+o details"), "{s:?}");
        assert_eq!(cursor, (2, 2));
    }

    #[test]
    fn narrow_terminals_drop_the_right_side_and_the_area_is_capped() {
        let mut m = Model::new("ses_7f3a", false);
        m.conn = crate::ui::model::Conn::Online;
        let ed = Editor::new(vec![]);
        let mut live = live_of(&m, &ed, 0, 36);
        live.top = (0..40).map(|i| TLine::row(2).s(format!("line {i}"), Sty::Plain)).collect();
        let (rows, _) = compose(&live, 36, 20);
        assert_eq!(rows.len(), 10, "half of 20 rows");
        let s = screen(&rows, 36, rows.len() as u16);
        assert_eq!(s[6], "  line 39");
        assert_eq!(s[9], "● idle");
        let (rows, _) = compose(&live, 36, 60);
        assert_eq!(rows.len(), MAX_LIVE);
        m.queued.push(crate::ui::model::Queued { turn_id: "tn_2".into(), text: "then run the whole suite".into(), who: None });
        let live = live_of(&m, &ed, 0, 80);
        let (rows, _) = compose(&live, 80, 24);
        let s = screen(&rows, 80, rows.len() as u16);
        assert_eq!(s[0], "  queued  then run the whole suite");
        assert!(s[3].starts_with("● idle · 1 queued"), "{s:?}");
    }

    #[test]
    fn short_terminals_never_get_more_rows_than_fit() {
        let m = Model::new("ses_7f3a", false);
        let mut ed = Editor::new(vec![]);
        ed.insert(&"a line\n".repeat(10));
        let mut live = live_of(&m, &ed, 0, 40);
        live.top = vec![TLine::row(2).s("streaming", Sty::Plain)];
        for h in 3..12 {
            let (rows, cursor) = compose(&live, 40, h);
            assert!(rows.len() < h, "{} rows for {h}", rows.len());
            assert!(cursor.0 < rows.len());
        }
        let (rows, _) = compose(&live, 40, 6);
        let s = screen(&rows, 40, rows.len() as u16);
        assert_eq!(s.len(), 5);
        assert!(s[0].starts_with("──") && s[4].ends_with("ctrl+o details"), "{s:?}");
        let (rows, _) = compose(&live, 40, 3);
        assert_eq!(rows.len(), 2, "the rule and one prompt row");
    }

    #[test]
    fn an_open_ask_takes_the_cursor_when_focused() {
        let ask: crate::api::types::Ask = serde_json::from_value(json!({"id": "ak_1", "kind": "approval", "status": "open", "approval": {"toolName": "Bash", "title": "terraform plan", "input": {}}})).unwrap();
        let mut ui = crate::ui::ask::AskUi::new(ask);
        ui.key(&crossterm::event::KeyEvent::new(crossterm::event::KeyCode::Char('e'), crossterm::event::KeyModifiers::NONE));
        let (lines, cur) = ui.render(60, true);
        let m = Model::new("ses_7f3a", false);
        let ed = Editor::new(vec![]);
        let mut live = live_of(&m, &ed, 0, 60);
        live.ask = lines;
        live.ask_cursor = cur;
        live.ask_focused = true;
        let (rows, cursor) = compose(&live, 60, 24);
        let s = screen(&rows, 60, rows.len() as u16);
        assert_eq!(s[0], "  ? Bash  terraform plan");
        assert_eq!(s[3], "    why:");
        assert_eq!(cursor, (3, 9));
    }
}
