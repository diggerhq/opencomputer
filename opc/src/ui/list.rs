//! An inline list in the live area: the session picker, the setting
//! choosers and `/subagents`. Nothing here is full-screen.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};

use super::{Seg, Sty, TLine, g, truncate, width};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Item {
    pub key: String,
    pub segs: Vec<Seg>,
    /// Matched by the filter.
    pub search: String,
    /// The current value of a setting.
    pub current: bool,
}

impl Item {
    pub fn new(key: impl Into<String>, label: impl Into<String>) -> Item {
        let label = label.into();
        Item { key: key.into(), search: label.to_lowercase(), segs: vec![Seg::new(label, Sty::Plain)], current: false }
    }
    pub fn segs(key: impl Into<String>, segs: Vec<Seg>) -> Item {
        let search = segs.iter().map(|s| s.text.as_str()).collect::<String>().to_lowercase();
        Item { key: key.into(), segs, search, current: false }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Pick {
    None,
    Close,
    Chosen(String),
    /// A letter key on the selected item (`x`, `y` in `/subagents`).
    Key(char, String),
}

#[derive(Debug, Clone)]
pub struct List {
    pub title: String,
    pub items: Vec<Item>,
    pub sel: usize,
    pub filter: String,
    /// Typing filters; otherwise letters go to [`Pick::Key`].
    pub filterable: bool,
    pub hint: String,
    /// Rows shown at most.
    pub max_rows: usize,
    /// A question shown instead of the hint (`stop "auth flow"? y/n`).
    pub confirm: Option<String>,
}

impl List {
    pub fn new(title: impl Into<String>, items: Vec<Item>, filterable: bool) -> List {
        let sel = items.iter().position(|i| i.current).unwrap_or(0);
        let hint = if filterable { "type to filter · enter choose · esc close" } else { "enter choose · esc close" };
        List { title: title.into(), items, sel, filter: String::new(), filterable, hint: hint.into(), max_rows: 8, confirm: None }
    }

    fn visible(&self) -> Vec<usize> {
        let f = self.filter.to_lowercase();
        self.items.iter().enumerate().filter(|(_, i)| f.is_empty() || f.split_whitespace().all(|w| i.search.contains(w))).map(|(n, _)| n).collect()
    }

    pub fn selected(&self) -> Option<&Item> {
        let v = self.visible();
        v.get(self.sel.min(v.len().saturating_sub(1))).map(|i| &self.items[*i])
    }

    /// Replaces the items, keeping the selection on the same key.
    pub fn refresh(&mut self, items: Vec<Item>) {
        let key = self.selected().map(|i| i.key.clone());
        self.items = items;
        if let Some(k) = key {
            let v = self.visible();
            if let Some(p) = v.iter().position(|i| self.items[*i].key == k) {
                self.sel = p;
            }
        }
    }

    pub fn key(&mut self, k: &KeyEvent) -> Pick {
        let n = self.visible().len();
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if let Some(_q) = &self.confirm {
            let key = self.selected().map(|i| i.key.clone()).unwrap_or_default();
            self.confirm = None;
            return match k.code {
                KeyCode::Char('y') => Pick::Key('y', key),
                _ => Pick::None,
            };
        }
        match k.code {
            KeyCode::Esc => return Pick::Close,
            KeyCode::Char('c') | KeyCode::Char('d') if ctrl => return Pick::Close,
            KeyCode::Up | KeyCode::Char('p') if k.code == KeyCode::Up || ctrl => self.sel = if self.sel == 0 { n.saturating_sub(1) } else { self.sel - 1 },
            KeyCode::Down | KeyCode::Char('n') if k.code == KeyCode::Down || ctrl => self.sel = if n == 0 || self.sel + 1 >= n { 0 } else { self.sel + 1 },
            KeyCode::Enter => return self.selected().map(|i| Pick::Chosen(i.key.clone())).unwrap_or(Pick::None),
            KeyCode::Backspace if self.filterable => {
                self.filter.pop();
                self.sel = 0;
            }
            KeyCode::Char(c) if !ctrl && self.filterable => {
                self.filter.push(c);
                self.sel = 0;
            }
            KeyCode::Char(c) if !ctrl && c.is_ascii_digit() && c != '0' => {
                let i = c as usize - '1' as usize;
                let v = self.visible();
                if let Some(x) = v.get(i) {
                    return Pick::Chosen(self.items[*x].key.clone());
                }
            }
            KeyCode::Char(c) if !ctrl => {
                if let Some(i) = self.selected() {
                    return Pick::Key(c, i.key.clone());
                }
            }
            _ => {}
        }
        Pick::None
    }

    pub fn render(&self, w: usize) -> Vec<TLine> {
        let mut out = Vec::new();
        let mut head = TLine::row(2).s(self.title.clone(), Sty::Bold);
        if self.filterable && !self.filter.is_empty() {
            head.push(format!("  {}", self.filter), Sty::Accent);
        }
        out.push(head);
        let v = self.visible();
        if v.is_empty() {
            out.push(TLine::row(4).s(if self.items.is_empty() { "nothing here" } else { "no match" }, Sty::Dim));
        }
        let sel = self.sel.min(v.len().saturating_sub(1));
        let start = if sel >= self.max_rows { sel + 1 - self.max_rows } else { 0 };
        for (row, idx) in v.iter().enumerate().skip(start).take(self.max_rows) {
            let it = &self.items[*idx];
            let mark = if row == sel { format!("{} ", g().select) } else { "  ".into() };
            let mut l = TLine::row(2).s(mark, Sty::Accent);
            let mut used = 4;
            for s in &it.segs {
                let room = w.saturating_sub(used + 2);
                if room == 0 {
                    break;
                }
                let t = truncate(&s.text, room);
                used += width(&t);
                l.segs.push(Seg { text: t, sty: if row == sel && s.sty == Sty::Plain { Sty::Bold } else { s.sty }, link: None });
            }
            if it.current {
                l.push(format!("  {}", g().ok), Sty::Ok);
            }
            out.push(l);
        }
        let foot = match &self.confirm {
            Some(q) => TLine::row(4).s(q.clone(), Sty::Warn),
            None => TLine::row(4).s(self.hint.clone(), Sty::Dim),
        };
        out.push(foot);
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }

    #[test]
    fn filters_moves_and_picks() {
        let mut l = List::new("sessions", vec![Item::new("a", "fix flaky test"), Item::new("b", "deploy staging"), Item::new("c", "flaky deploy")], true);
        l.key(&k(KeyCode::Char('f')));
        l.key(&k(KeyCode::Char('l')));
        assert_eq!(l.render(60).len(), 4);
        l.key(&k(KeyCode::Down));
        assert_eq!(l.key(&k(KeyCode::Enter)), Pick::Chosen("c".into()));
        assert_eq!(l.key(&k(KeyCode::Esc)), Pick::Close);
    }

    #[test]
    fn letters_act_on_the_selection_with_confirmation() {
        let mut l = List::new("subagents", vec![Item::new("sa_1", "auth flow")], false);
        assert_eq!(l.key(&k(KeyCode::Char('x'))), Pick::Key('x', "sa_1".into()));
        l.confirm = Some("stop \"auth flow\"? y/n".into());
        assert_eq!(l.key(&k(KeyCode::Char('y'))), Pick::Key('y', "sa_1".into()));
        assert_eq!(l.key(&k(KeyCode::Char('1'))), Pick::Chosen("sa_1".into()));
    }
}
