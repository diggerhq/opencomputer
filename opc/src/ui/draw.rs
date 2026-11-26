//! The inline renderer. Settled lines are written once into the terminal's
//! normal screen, where scrollback, search and copy work as usual. The live
//! area under them is erased and drawn again each frame. The alternate
//! screen is never used.

use std::io::Write;
use std::sync::atomic::{AtomicUsize, Ordering};

use super::model::RIGHT;
use super::view::Row;
use super::{Sty, TLine};

/// Synchronized output, so a frame never shows half drawn.
const SYNC_ON: &str = "\x1b[?2026h";
const SYNC_OFF: &str = "\x1b[?2026l";

/// SGR parameters of a meaning, in the 16 colors of the person's palette.
fn sgr(s: Sty) -> &'static str {
    match s {
        Sty::Plain => "",
        Sty::Dim => "2",
        Sty::Bold | Sty::Heading => "1",
        Sty::Italic => "3",
        Sty::Code | Sty::Block | Sty::Accent => "36",
        Sty::Link => "4;34",
        Sty::Ok => "32",
        Sty::Err => "31",
        Sty::Warn => "33",
        Sty::Me => "1;34",
        Sty::Person => "1;35",
    }
}

/// A link target that is safe to put in OSC 8.
fn safe_url(u: &str) -> Option<&str> {
    let ok = (u.starts_with("https://") || u.starts_with("http://")) && !u.chars().any(|c| c.is_control() || c == '\x1b');
    ok.then_some(u)
}

/// A row as text with escape sequences (none when `color` is off).
pub fn ansi(row: &Row, color: bool) -> String {
    let mut out = String::new();
    for s in row {
        let text = super::clean(&s.text).replace('\n', " ");
        let link = if color { s.link.as_deref().filter(|l| *l != RIGHT).and_then(safe_url) } else { None };
        if let Some(u) = link {
            out.push_str(&format!("\x1b]8;;{u}\x1b\\"));
        }
        let code = if color { sgr(s.sty) } else { "" };
        if code.is_empty() {
            out.push_str(&text);
        } else {
            out.push_str(&format!("\x1b[{code}m{text}\x1b[0m"));
        }
        if link.is_some() {
            out.push_str("\x1b]8;;\x1b\\");
        }
    }
    out
}

/// Lines from the cursor up to the live area's top, for the panic hook.
static LIVE_UP: AtomicUsize = AtomicUsize::new(0);

/// Moves `n` lines up to the live area's top and erases from there down.
fn erase(n: usize) -> String {
    let mut s = String::from("\r");
    if n > 0 {
        s.push_str(&format!("\x1b[{n}A"));
    }
    s.push_str("\x1b[J");
    s
}

/// Erases the live area the last frame drew (the panic hook).
pub fn erase_live() -> String {
    erase(LIVE_UP.load(Ordering::SeqCst))
}

/// Where the live area is on screen, from the last frame.
#[derive(Debug, Default)]
pub struct Painter {
    /// The cursor's row in the live area as left by the last frame.
    cursor_row: usize,
    cursor_col: usize,
    /// Widths of the last frame's rows, and the width they were made for.
    widths: Vec<usize>,
    frame_w: usize,
    /// The terminal's width now, when it changed since the last frame.
    term_w: Option<usize>,
    pub color: bool,
}

impl Painter {
    pub fn new(color: bool) -> Painter {
        Painter { color, ..Painter::default() }
    }

    /// The terminal's width changed: the rows it reflowed take more lines,
    /// so the next erase goes up further.
    pub fn resized(&mut self, w: usize) {
        self.term_w = Some(w.max(1)).filter(|w| *w != self.frame_w);
        LIVE_UP.store(self.up(), Ordering::SeqCst);
    }

    /// Lines from the cursor up to the live area's top.
    fn up(&self) -> usize {
        match self.term_w {
            None => self.cursor_row,
            Some(w) => self.widths[..self.cursor_row.min(self.widths.len())].iter().map(|n| n.div_ceil(w).max(1)).sum::<usize>() + self.cursor_col / w,
        }
    }

    fn forget(&mut self) {
        self.cursor_row = 0;
        self.cursor_col = 0;
        self.widths.clear();
        self.term_w = None;
        LIVE_UP.store(0, Ordering::SeqCst);
    }

    /// One frame: the settled lines go above, the live area is redrawn
    /// under them, and the cursor is placed.
    pub fn frame(&mut self, out: &mut impl Write, settled: &[TLine], live: &[Row], cursor: (usize, usize), w: usize) -> std::io::Result<()> {
        let mut buf = String::with_capacity(4096);
        buf.push_str(SYNC_ON);
        buf.push_str(&self.erase_seq());
        for l in settled {
            for r in super::view::wrap(l, w) {
                buf.push_str(&ansi(&r, self.color));
                buf.push_str("\r\n");
            }
        }
        for (i, r) in live.iter().enumerate() {
            if i > 0 {
                buf.push_str("\r\n");
            }
            buf.push_str(&ansi(r, self.color));
        }
        let last = live.len().saturating_sub(1);
        let (cr, cc) = (cursor.0.min(last), cursor.1);
        if last > cr {
            buf.push_str(&format!("\x1b[{}A", last - cr));
        }
        buf.push('\r');
        if cc > 0 {
            buf.push_str(&format!("\x1b[{cc}C"));
        }
        buf.push_str("\x1b[?25h");
        buf.push_str(SYNC_OFF);
        self.cursor_row = cr;
        self.cursor_col = cc;
        self.widths = live.iter().map(super::view::row_width).collect();
        self.frame_w = w;
        self.term_w = None;
        LIVE_UP.store(cr, Ordering::SeqCst);
        out.write_all(buf.as_bytes())?;
        out.flush()
    }

    /// Moves to the top of the live area and erases it.
    fn erase_seq(&self) -> String {
        erase(self.up())
    }

    /// Erases the live area, leaving the cursor where it began: before
    /// handing the terminal to another program, and on exit.
    pub fn clear(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        let s = self.erase_seq();
        self.forget();
        out.write_all(s.as_bytes())?;
        out.flush()
    }

    /// `Ctrl+L`: clears the screen; the next frame draws at the top.
    pub fn clear_screen(&mut self, out: &mut impl Write) -> std::io::Result<()> {
        self.forget();
        out.write_all(b"\x1b[2J\x1b[H")?;
        out.flush()
    }

    /// Prints settled lines and leaves the live area erased: on exit, the
    /// last lines stay above the shell's prompt.
    pub fn finish(&mut self, out: &mut impl Write, settled: &[TLine], w: usize) -> std::io::Result<()> {
        let mut buf = self.erase_seq();
        for l in settled {
            for r in super::view::wrap(l, w) {
                buf.push_str(&ansi(&r, self.color));
                buf.push_str("\r\n");
            }
        }
        self.forget();
        out.write_all(buf.as_bytes())?;
        out.flush()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ui::Seg;

    #[test]
    fn frames_redraw_only_the_live_area() {
        let mut p = Painter::new(false);
        let mut out = Vec::new();
        let live = vec![vec![Seg::new("─────", Sty::Dim)], vec![Seg::new("> hi", Sty::Plain)], vec![Seg::new("● idle", Sty::Dim)]];
        p.frame(&mut out, &[TLine::row(0).s("you   hello", Sty::Me)], &live, (1, 4), 40).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert_eq!(s, "\x1b[?2026h\r\x1b[Jyou   hello\r\n─────\r\n> hi\r\n● idle\x1b[1A\r\x1b[4C\x1b[?25h\x1b[?2026l");
        let mut out = Vec::new();
        p.frame(&mut out, &[], &live, (1, 4), 40).unwrap();
        let s = String::from_utf8(out).unwrap();
        assert!(s.starts_with("\x1b[?2026h\r\x1b[1A\x1b[J─────"), "{s:?}");
        assert!(!s.contains("hello"));
    }

    #[test]
    fn a_narrower_terminal_erases_the_reflowed_rows() {
        let mut p = Painter::new(false);
        let live = vec![vec![Seg::new("x".repeat(30), Sty::Plain)], vec![Seg::new("> hi", Sty::Plain)], vec![Seg::new("● idle", Sty::Dim)]];
        p.frame(&mut Vec::new(), &[], &live, (1, 4), 40).unwrap();
        // 30 columns at 20 wide are two lines: two up to the top.
        p.resized(20);
        let mut out = Vec::new();
        p.frame(&mut out, &[], &live, (1, 4), 20).unwrap();
        assert!(String::from_utf8(out).unwrap().starts_with("\x1b[?2026h\r\x1b[2A\x1b[J"));
        p.resized(40);
        assert_eq!(p.erase_seq(), "\r\x1b[1A\x1b[J");
    }

    #[test]
    fn styles_and_links_only_with_color() {
        let mut s = Seg::new("docs", Sty::Link);
        s.link = Some("https://example.com/docs".into());
        assert_eq!(ansi(&vec![s.clone()], false), "docs");
        assert_eq!(ansi(&vec![s], true), "\x1b]8;;https://example.com/docs\x1b\\\x1b[4;34mdocs\x1b[0m\x1b]8;;\x1b\\");
        let mut bad = Seg::new("x", Sty::Plain);
        bad.link = Some("javascript:\x1b]0;pwn".into());
        assert_eq!(ansi(&vec![bad], true), "x");
        assert_eq!(ansi(&vec![Seg::new("a\x1b[2Jb", Sty::Plain)], true), "a[2Jb");
    }
}
