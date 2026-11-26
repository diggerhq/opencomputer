//! The interactive session screen: `opc`, `opc a`.
//!
//! Layout of the module:
//! - [`model`] is the pure state of a session screen: recorded events and
//!   deltas go in, settled transcript lines and live state come out. No IO.
//! - [`text`] renders streaming markdown into lines.
//! - [`prompt`], [`ask`], [`list`] are the pure input widgets.
//! - [`view`] draws the live area into a ratatui `Buffer`.
//! - [`draw`] is the inline renderer: it writes settled lines into the
//!   terminal's normal screen and redraws the live area under them. The
//!   alternate screen is never used.
//! - [`app`] is the async loop that wires the connection, the keyboard and
//!   the model together. [`plain`] is the output when stdout is no terminal.

pub mod app;
pub mod ask;
pub mod details;
pub mod draw;
pub mod list;
pub mod model;
pub mod notify;
pub mod plain;
pub mod prompt;
pub mod slash;
pub mod term;
pub mod text;
pub mod view;

use std::sync::OnceLock;
use unicode_width::{UnicodeWidthChar, UnicodeWidthStr};

/// What a piece of text means, mapped to 16-color styles when drawn.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Sty {
    #[default]
    Plain,
    Dim,
    Bold,
    Italic,
    /// Inline code.
    Code,
    /// A line of a code block.
    Block,
    Heading,
    Link,
    Ok,
    Err,
    Warn,
    Accent,
    /// The `you` label.
    Me,
    /// Another person's label.
    Person,
}

/// A run of text with one style.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Seg {
    pub text: String,
    pub sty: Sty,
    /// An OSC 8 link target.
    pub link: Option<String>,
}

impl Seg {
    pub fn new(text: impl Into<String>, sty: Sty) -> Seg {
        Seg { text: text.into(), sty, link: None }
    }
}

/// One logical line of the transcript or the live area. Prose wraps to the
/// width at print time: the first row starts at `lead` columns, the rest at
/// `indent`. `nowrap` lines (code, tables, steps) are never broken by opc.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct TLine {
    pub segs: Vec<Seg>,
    pub lead: usize,
    pub indent: usize,
    pub nowrap: bool,
}

impl TLine {
    pub fn new(lead: usize, indent: usize) -> TLine {
        TLine { segs: Vec::new(), lead, indent, nowrap: false }
    }
    pub fn blank() -> TLine {
        TLine::default()
    }
    /// A one-row line at `lead` that is truncated rather than wrapped.
    pub fn row(lead: usize) -> TLine {
        TLine { segs: Vec::new(), lead, indent: lead, nowrap: true }
    }
    pub fn s(mut self, text: impl Into<String>, sty: Sty) -> TLine {
        let text = text.into();
        if !text.is_empty() {
            self.segs.push(Seg::new(text, sty));
        }
        self
    }
    pub fn push(&mut self, text: impl Into<String>, sty: Sty) {
        let text = text.into();
        if !text.is_empty() {
            self.segs.push(Seg::new(text, sty));
        }
    }
    /// The text without styles, `lead` spaces first.
    pub fn plain(&self) -> String {
        let mut s = " ".repeat(self.lead);
        for g in &self.segs {
            s.push_str(&g.text);
        }
        s
    }
    pub fn is_blank(&self) -> bool {
        self.segs.iter().all(|s| s.text.trim().is_empty())
    }
}

/// Symbols, with an ASCII set for terminals and locales that cannot show them.
#[derive(Debug)]
pub struct Glyphs {
    pub ok: &'static str,
    pub fail: &'static str,
    pub ask: &'static str,
    pub dot: &'static str,
    pub ring: &'static str,
    pub half: &'static str,
    pub suspended: &'static str,
    pub steer: &'static str,
    pub rule: &'static str,
    pub mid: &'static str,
    pub bullet: &'static str,
    pub select: &'static str,
    pub times: &'static str,
    pub minus: &'static str,
    pub head: &'static str,
    pub up: &'static str,
    pub down: &'static str,
    pub ellipsis: &'static str,
    pub arrow: &'static str,
    pub cursor_bar: &'static str,
    pub spinner: &'static [&'static str],
}

pub static UNICODE: Glyphs = Glyphs {
    ok: "✓",
    fail: "✗",
    ask: "◆",
    dot: "●",
    ring: "○",
    half: "◐",
    suspended: "◌",
    steer: "↳",
    rule: "─",
    mid: "·",
    bullet: "•",
    select: "❯",
    times: "×",
    minus: "−",
    head: "▸",
    up: "↑",
    down: "↓",
    ellipsis: "…",
    arrow: "→",
    cursor_bar: "│",
    spinner: &["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"],
};

pub static ASCII: Glyphs = Glyphs {
    ok: "v",
    fail: "x",
    ask: "*",
    dot: "*",
    ring: "o",
    half: "~",
    suspended: "o",
    steer: "->",
    rule: "-",
    mid: "-",
    bullet: "-",
    select: ">",
    times: "x",
    minus: "-",
    head: ">",
    up: "^",
    down: "v",
    ellipsis: "...",
    arrow: "->",
    cursor_bar: "|",
    spinner: &["|", "/", "-", "\\"],
};

static ASCII_ONLY: OnceLock<bool> = OnceLock::new();

/// ASCII when the terminal is the Linux console, or the locale is set and is
/// not UTF-8.
pub fn wants_ascii(env: impl Fn(&str) -> Option<String>) -> bool {
    if env("TERM").as_deref() == Some("linux") {
        return true;
    }
    for k in ["LC_ALL", "LC_CTYPE", "LANG"] {
        if let Some(v) = env(k).filter(|v| !v.is_empty()) {
            let v = v.to_ascii_lowercase();
            return !(v.contains("utf-8") || v.contains("utf8"));
        }
    }
    false
}

/// The symbol set, chosen once from the locale and terminal (Unicode in unit
/// tests, whatever the machine's locale).
pub fn g() -> &'static Glyphs {
    if *ASCII_ONLY.get_or_init(|| !cfg!(test) && wants_ascii(|k| std::env::var(k).ok())) { &ASCII } else { &UNICODE }
}

pub fn spinner(now_ms: i64) -> &'static str {
    let s = g().spinner;
    s[((now_ms.max(0) / 80) as usize) % s.len()]
}

/// Display width of a string.
pub fn width(s: &str) -> usize {
    UnicodeWidthStr::width(s)
}

pub fn char_width(c: char) -> usize {
    UnicodeWidthChar::width(c).unwrap_or(0)
}

/// Cuts `s` to at most `w` columns, ending in `…` when it was cut.
pub fn truncate(s: &str, w: usize) -> String {
    if width(s) <= w {
        return s.to_string();
    }
    if w == 0 {
        return String::new();
    }
    let ell = g().ellipsis;
    let budget = w.saturating_sub(width(ell));
    let mut out = String::new();
    let mut used = 0;
    for c in s.chars() {
        let cw = char_width(c);
        if used + cw > budget {
            break;
        }
        used += cw;
        out.push(c);
    }
    out.push_str(ell);
    out
}

/// The first line of `s`, trimmed, for one-line summaries.
pub fn first_line(s: &str) -> &str {
    s.trim().lines().next().unwrap_or("").trim()
}

/// A settled duration: `0.8 s`, `6.2 s`, `16 s`, `1m 12s`, `3m`, `1h 4m`.
pub fn dur(ms: u64) -> String {
    if ms < 10_000 {
        return format!("{:.1} s", ms as f64 / 1000.0);
    }
    timer(ms)
}

/// A running timer, in whole seconds: `2 s`, `59 s`, `1m 12s`.
pub fn timer(ms: u64) -> String {
    let s = ms / 1000;
    if s < 60 {
        return format!("{s} s");
    }
    if s < 3600 {
        let (m, r) = (s / 60, s % 60);
        return if r == 0 { format!("{m}m") } else { format!("{m}m {r}s") };
    }
    let (h, m) = (s / 3600, (s % 3600) / 60);
    if m == 0 { format!("{h}h") } else { format!("{h}h {m}m") }
}

/// `950`, `41k`, `1.2M`.
pub fn tokens(n: u64) -> String {
    if n < 1000 {
        n.to_string()
    } else if n < 1_000_000 {
        format!("{}k", n / 1000)
    } else {
        format!("{:.1}M", n as f64 / 1_000_000.0)
    }
}

/// `1 subagent`, `2 subagents`.
pub fn plural(n: usize, one: &str) -> String {
    if n == 1 { format!("1 {one}") } else { format!("{n} {one}s") }
}

/// Removes control characters, so server text cannot move the cursor or
/// change the terminal.
pub fn clean(s: &str) -> String {
    s.chars().filter(|c| !c.is_control() || *c == '\n' || *c == '\t').map(|c| if c == '\t' { ' ' } else { c }).collect()
}

/// Parses an RFC 3339 time to milliseconds since the epoch.
pub fn parse_time(s: &str) -> Option<i64> {
    let t = time::OffsetDateTime::parse(s, &time::format_description::well_known::Rfc3339).ok()?;
    Some((t.unix_timestamp_nanos() / 1_000_000) as i64)
}

/// Now, in milliseconds since the epoch.
pub fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn durations() {
        assert_eq!(dur(6200), "6.2 s");
        assert_eq!(dur(16_000), "16 s");
        assert_eq!(dur(72_000), "1m 12s");
        assert_eq!(dur(180_000), "3m");
        assert_eq!(timer(2400), "2 s");
        assert_eq!(tokens(41_234), "41k");
    }

    #[test]
    fn ascii_from_locale() {
        let env = |pairs: &'static [(&'static str, &'static str)]| move |k: &str| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| v.to_string());
        assert!(!wants_ascii(env(&[("LANG", "en_US.UTF-8")])));
        assert!(wants_ascii(env(&[("LANG", "C")])));
        assert!(wants_ascii(env(&[("TERM", "linux"), ("LANG", "en_US.UTF-8")])));
        assert!(!wants_ascii(env(&[])));
    }

    #[test]
    fn truncation() {
        assert_eq!(truncate("hello world", 8), "hello w…");
        assert_eq!(truncate("hi", 8), "hi");
        assert_eq!(clean("a\x1b[2Jb\tc"), "a[2Jb c");
    }
}
