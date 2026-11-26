//! The prompt line: editing as in a shell, history, `Ctrl+R`, and pastes.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::{Seg, Sty, TLine, char_width, width};

/// A paste longer than this many lines is shown collapsed.
const COLLAPSE_LINES: usize = 1000;
/// Tab stops in the prompt line.
const TAB: usize = 4;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Edit {
    /// The key changed the line or moved in it.
    Done,
    /// `Enter`: the message, pastes expanded.
    Submit(String),
    /// Not a key for the line; the app decides.
    Ignored,
}

#[derive(Debug, Clone, Default)]
struct Search {
    query: String,
    /// Index in `history` of the current match.
    at: Option<usize>,
}

#[derive(Debug, Clone, Default)]
pub struct Editor {
    buf: Vec<char>,
    cur: usize,
    pub history: Vec<String>,
    /// Position while walking the history; `history.len()` is the draft.
    hpos: usize,
    draft: String,
    search: Option<Search>,
    /// Collapsed pastes: the placeholder and the text.
    pastes: Vec<(String, String)>,
    /// `Ctrl+X` was pressed: the next `Ctrl+E` opens the editor.
    ctrl_x: bool,
}

fn is_word(c: char) -> bool {
    c.is_alphanumeric() || c == '_'
}

impl Editor {
    pub fn new(history: Vec<String>) -> Editor {
        let hpos = history.len();
        Editor { history, hpos, ..Default::default() }
    }

    pub fn text(&self) -> String {
        self.buf.iter().collect()
    }

    pub fn is_empty(&self) -> bool {
        self.buf.is_empty()
    }

    pub fn searching(&self) -> bool {
        self.search.is_some()
    }

    pub fn set(&mut self, s: &str) {
        self.buf = s.chars().collect();
        self.cur = self.buf.len();
        self.pastes.clear();
    }

    pub fn clear(&mut self) {
        self.set("");
        self.hpos = self.history.len();
    }

    /// Puts text taken back (a cancelled message) before what is there.
    pub fn restore(&mut self, s: &str) {
        let now = self.text();
        if now.trim().is_empty() {
            self.set(s);
        } else {
            self.set(&format!("{s}\n{now}"));
        }
    }

    pub fn insert(&mut self, s: &str) {
        for c in s.chars() {
            let c = if c == '\r' { '\n' } else { c };
            if c.is_control() && c != '\n' && c != '\t' {
                continue;
            }
            self.buf.insert(self.cur, c);
            self.cur += 1;
        }
    }

    pub fn paste(&mut self, s: &str) {
        let s = s.replace("\r\n", "\n").replace('\r', "\n");
        let lines = s.lines().count();
        if lines > COLLAPSE_LINES {
            let n = lines.to_string();
            let n = if n.len() > 3 { format!("{},{}", &n[..n.len() - 3], &n[n.len() - 3..]) } else { n };
            let mut ph = format!("[pasted {n} lines]");
            let mut k = 2;
            while self.pastes.iter().any(|(p, _)| *p == ph) {
                ph = format!("[pasted {n} lines #{k}]");
                k += 1;
            }
            self.insert(&ph);
            self.pastes.push((ph, s));
        } else {
            self.insert(&s);
        }
    }

    /// The message to send: collapsed pastes put back in full.
    pub fn expanded(&self) -> String {
        let mut t = self.text();
        for (ph, full) in &self.pastes {
            t = t.replacen(ph.as_str(), full, 1);
        }
        t
    }

    fn line_bounds(&self) -> (usize, usize) {
        let start = self.buf[..self.cur].iter().rposition(|c| *c == '\n').map(|i| i + 1).unwrap_or(0);
        let end = self.buf[self.cur..].iter().position(|c| *c == '\n').map(|i| self.cur + i).unwrap_or(self.buf.len());
        (start, end)
    }

    fn word_left(&self) -> usize {
        let mut i = self.cur;
        while i > 0 && !is_word(self.buf[i - 1]) {
            i -= 1;
        }
        while i > 0 && is_word(self.buf[i - 1]) {
            i -= 1;
        }
        i
    }

    fn word_right(&self) -> usize {
        let mut i = self.cur;
        while i < self.buf.len() && !is_word(self.buf[i]) {
            i += 1;
        }
        while i < self.buf.len() && is_word(self.buf[i]) {
            i += 1;
        }
        i
    }

    fn vertical(&mut self, up: bool) -> bool {
        let (start, end) = self.line_bounds();
        let col = self.cur - start;
        if up {
            if start == 0 {
                return false;
            }
            let pend = start - 1;
            let pstart = self.buf[..pend].iter().rposition(|c| *c == '\n').map(|i| i + 1).unwrap_or(0);
            self.cur = (pstart + col).min(pend);
        } else {
            if end == self.buf.len() {
                return false;
            }
            let nstart = end + 1;
            let nend = self.buf[nstart..].iter().position(|c| *c == '\n').map(|i| nstart + i).unwrap_or(self.buf.len());
            self.cur = (nstart + col).min(nend);
        }
        true
    }

    fn history_move(&mut self, back: bool) -> bool {
        if self.history.is_empty() {
            return false;
        }
        if self.hpos == self.history.len() {
            self.draft = self.text();
        }
        let next = if back {
            if self.hpos == 0 {
                return true;
            }
            self.hpos - 1
        } else {
            if self.hpos >= self.history.len() {
                return false;
            }
            self.hpos + 1
        };
        self.hpos = next;
        let t = if next == self.history.len() { self.draft.clone() } else { self.history[next].clone() };
        self.buf = t.chars().collect();
        self.cur = self.buf.len();
        true
    }

    /// Records a sent message in this editor's history.
    pub fn remember(&mut self, s: &str) {
        if !s.trim().is_empty() && self.history.last().map(String::as_str) != Some(s) {
            self.history.push(s.to_string());
        }
        self.hpos = self.history.len();
    }

    fn search_key(&mut self, k: &KeyEvent) -> Edit {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let Some(st) = self.search.as_mut() else { return Edit::Ignored };
        let find = |h: &[String], q: &str, before: usize| h[..before].iter().rposition(|x| x.contains(q));
        match k.code {
            KeyCode::Char('r') if ctrl => {
                let before = st.at.unwrap_or(self.history.len());
                if let Some(i) = find(&self.history, &st.query, before) {
                    st.at = Some(i);
                }
            }
            KeyCode::Char('g') | KeyCode::Char('c') if ctrl => {
                self.search = None;
            }
            KeyCode::Esc => self.search = None,
            KeyCode::Backspace => {
                st.query.pop();
                st.at = find(&self.history, &st.query, self.history.len());
            }
            KeyCode::Char(c) if !ctrl => {
                st.query.push(c);
                st.at = find(&self.history, &st.query, self.history.len());
            }
            _ => {
                // Any other key takes the match and acts on the line.
                let at = st.at;
                self.search = None;
                if let Some(i) = at {
                    let t = self.history[i].clone();
                    self.set(&t);
                }
                if k.code == KeyCode::Enter {
                    return Edit::Done;
                }
                return self.key(k);
            }
        }
        Edit::Done
    }

    /// One key. `Enter` submits unless the line ends in `\`.
    pub fn key(&mut self, k: &KeyEvent) -> Edit {
        if self.search.is_some() {
            return self.search_key(k);
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let alt = k.modifiers.contains(KeyModifiers::ALT);
        let shift = k.modifiers.contains(KeyModifiers::SHIFT);
        if std::mem::take(&mut self.ctrl_x) && ctrl && k.code == KeyCode::Char('e') {
            return Edit::Ignored; // the app opens $EDITOR: see `wants_editor`
        }
        match k.code {
            KeyCode::Enter if ctrl || alt || shift => self.insert("\n"),
            KeyCode::Char('j') if ctrl => self.insert("\n"),
            KeyCode::Enter => {
                if self.cur > 0 && self.buf.get(self.cur - 1) == Some(&'\\') {
                    self.buf.remove(self.cur - 1);
                    self.cur -= 1;
                    self.insert("\n");
                    return Edit::Done;
                }
                let t = self.expanded();
                return Edit::Submit(t);
            }
            KeyCode::Char('x') if ctrl => self.ctrl_x = true,
            KeyCode::Char('a') if ctrl => self.cur = self.line_bounds().0,
            KeyCode::Char('e') if ctrl => self.cur = self.line_bounds().1,
            KeyCode::Home => self.cur = self.line_bounds().0,
            KeyCode::End => self.cur = self.line_bounds().1,
            KeyCode::Char('b') if alt => self.cur = self.word_left(),
            KeyCode::Char('f') if alt => self.cur = self.word_right(),
            KeyCode::Left if ctrl || alt => self.cur = self.word_left(),
            KeyCode::Right if ctrl || alt => self.cur = self.word_right(),
            KeyCode::Char('b') if ctrl => self.cur = self.cur.saturating_sub(1),
            KeyCode::Char('f') if ctrl => self.cur = (self.cur + 1).min(self.buf.len()),
            KeyCode::Left => self.cur = self.cur.saturating_sub(1),
            KeyCode::Right => self.cur = (self.cur + 1).min(self.buf.len()),
            KeyCode::Char('w') if ctrl => {
                let to = self.word_left();
                self.buf.drain(to..self.cur);
                self.cur = to;
            }
            KeyCode::Backspace if alt || ctrl => {
                let to = self.word_left();
                self.buf.drain(to..self.cur);
                self.cur = to;
            }
            KeyCode::Char('u') if ctrl => {
                let s = self.line_bounds().0;
                let s = if s == self.cur && s > 0 { s - 1 } else { s };
                self.buf.drain(s..self.cur);
                self.cur = s;
            }
            KeyCode::Char('k') if ctrl => {
                let e = self.line_bounds().1;
                let e = if e == self.cur && e < self.buf.len() { e + 1 } else { e };
                self.buf.drain(self.cur..e);
            }
            KeyCode::Backspace | KeyCode::Char('h') if k.code == KeyCode::Backspace || ctrl => {
                if self.cur > 0 {
                    self.cur -= 1;
                    self.buf.remove(self.cur);
                }
            }
            KeyCode::Delete => {
                if self.cur < self.buf.len() {
                    self.buf.remove(self.cur);
                }
            }
            KeyCode::Up | KeyCode::Char('p') if k.code == KeyCode::Up || ctrl => {
                if !self.vertical(true) && !self.history_move(true) {
                    return Edit::Ignored;
                }
            }
            KeyCode::Down | KeyCode::Char('n') if k.code == KeyCode::Down || ctrl => {
                if !self.vertical(false) && !self.history_move(false) {
                    return Edit::Ignored;
                }
            }
            KeyCode::Char('r') if ctrl => self.search = Some(Search::default()),
            KeyCode::Char(c) if !ctrl => {
                let mut b = [0u8; 4];
                self.insert(c.encode_utf8(&mut b));
            }
            _ => return Edit::Ignored,
        }
        Edit::Done
    }

    /// `Ctrl+X Ctrl+E` was the last chord.
    pub fn wants_editor(k: &KeyEvent, was_ctrl_x: bool) -> bool {
        was_ctrl_x && k.modifiers.contains(KeyModifiers::CONTROL) && k.code == KeyCode::Char('e')
    }

    pub fn pending_ctrl_x(&self) -> bool {
        self.ctrl_x
    }

    /// The prompt's rows at this width, and the cursor's (row, column).
    pub fn render(&self, w: usize, placeholder: &str) -> (Vec<TLine>, (usize, usize)) {
        let w = w.max(4);
        if let Some(st) = &self.search {
            let m = st.at.map(|i| self.history[i].replace('\n', " ")).unwrap_or_default();
            let head = format!("(search) {}", st.query);
            let l = TLine::row(0).s(head.clone(), Sty::Accent).s(format!("  {m}"), Sty::Plain);
            return (vec![l], (0, width(&head).min(w - 1)));
        }
        let prompt = "> ".to_string();
        let pw = width(&prompt);
        let mut rows: Vec<Vec<char>> = vec![Vec::new()];
        let mut col = pw;
        let mut cursor = (0, pw);
        let text: Vec<char> = self.buf.clone();
        for (i, c) in text.iter().enumerate() {
            if *c == '\n' {
                if i == self.cur {
                    cursor = (rows.len() - 1, col);
                }
                rows.push(Vec::new());
                col = pw;
                continue;
            }
            // A tab shows as spaces to the next multiple of 4.
            let tab = TAB - (col - pw) % TAB;
            let cw = if *c == '\t' { tab } else { char_width(*c) };
            if col + cw > w {
                rows.push(Vec::new());
                col = pw;
            }
            if i == self.cur {
                cursor = (rows.len() - 1, col);
            }
            if let Some(r) = rows.last_mut() {
                match c {
                    '\t' => r.extend(std::iter::repeat_n(' ', cw.min(w - col))),
                    _ => r.push(*c),
                }
            }
            col += cw;
        }
        if self.cur >= text.len() {
            if col >= w {
                rows.push(Vec::new());
                col = pw;
            }
            cursor = (rows.len() - 1, col);
        }
        let mut out = Vec::new();
        for (i, r) in rows.iter().enumerate() {
            let lead = if i == 0 { Seg::new(prompt.clone(), Sty::Accent) } else { Seg::new(" ".repeat(pw), Sty::Plain) };
            let mut l = TLine::row(0);
            l.segs.push(lead);
            l.push(r.iter().collect::<String>(), Sty::Plain);
            out.push(l);
        }
        if self.buf.is_empty() && !placeholder.is_empty() {
            out[0].push(placeholder, Sty::Dim);
        }
        (out, cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn c(ch: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(ch), KeyModifiers::CONTROL)
    }
    fn typed(e: &mut Editor, s: &str) {
        for ch in s.chars() {
            e.key(&k(KeyCode::Char(ch)));
        }
    }

    #[test]
    fn edits_like_a_shell() {
        let mut e = Editor::new(vec![]);
        typed(&mut e, "fix the flaky test");
        e.key(&c('w'));
        assert_eq!(e.text(), "fix the flaky ");
        e.key(&c('a'));
        e.key(&KeyEvent::new(KeyCode::Char('f'), KeyModifiers::ALT));
        e.key(&c('k'));
        assert_eq!(e.text(), "fix");
        e.key(&c('u'));
        assert!(e.is_empty());
    }

    #[test]
    fn enter_sends_and_backslash_enter_breaks_the_line() {
        let mut e = Editor::new(vec![]);
        typed(&mut e, "one\\");
        assert_eq!(e.key(&k(KeyCode::Enter)), Edit::Done);
        typed(&mut e, "two");
        e.key(&KeyEvent::new(KeyCode::Enter, KeyModifiers::SHIFT));
        typed(&mut e, "three");
        assert_eq!(e.key(&k(KeyCode::Enter)), Edit::Submit("one\ntwo\nthree".into()));
    }

    #[test]
    fn history_and_search() {
        let mut e = Editor::new(vec!["run the suite".into(), "fix segment.test.ts".into()]);
        typed(&mut e, "draft");
        e.key(&k(KeyCode::Up));
        assert_eq!(e.text(), "fix segment.test.ts");
        e.key(&k(KeyCode::Up));
        assert_eq!(e.text(), "run the suite");
        e.key(&k(KeyCode::Down));
        e.key(&k(KeyCode::Down));
        assert_eq!(e.text(), "draft");
        e.clear();
        e.key(&c('r'));
        typed(&mut e, "suite");
        assert!(e.searching());
        e.key(&k(KeyCode::Right));
        assert!(!e.searching());
        assert_eq!(e.text(), "run the suite");
    }

    #[test]
    fn long_pastes_collapse_and_send_in_full() {
        let mut e = Editor::new(vec![]);
        let big = (0..1204).map(|i| format!("line {i}")).collect::<Vec<_>>().join("\n");
        e.paste(&big);
        assert_eq!(e.text(), "[pasted 1,204 lines]");
        assert_eq!(e.key(&k(KeyCode::Enter)), Edit::Submit(big));
        let mut e = Editor::new(vec![]);
        e.paste("a\nb");
        assert_eq!(e.text(), "a\nb");
    }

    #[test]
    fn renders_with_the_cursor_where_it_is() {
        let mut e = Editor::new(vec![]);
        typed(&mut e, "hello");
        let (rows, cur) = e.render(40, "");
        assert_eq!(rows[0].plain(), "> hello");
        assert_eq!(cur, (0, 7));
    }

    #[test]
    fn tabs_are_kept_and_shown_as_spaces() {
        let mut e = Editor::new(vec![]);
        e.paste("build:\n\tgo build ./...");
        assert_eq!(e.expanded(), "build:\n\tgo build ./...");
        let (rows, cur) = e.render(40, "");
        assert_eq!(rows[1].plain(), "      go build ./...");
        assert_eq!(cur, (1, 20));
    }

    #[test]
    fn the_cursor_goes_to_the_next_row_at_a_wrap() {
        let mut e = Editor::new(vec![]);
        typed(&mut e, "abcdefgh");
        e.key(&k(KeyCode::Left));
        // "> abcdefg" fills 9 columns; "h", under the cursor, wraps.
        let (rows, cur) = e.render(9, "");
        assert_eq!(rows[1].plain(), "  h");
        assert_eq!(cur, (1, 2));
    }
}
