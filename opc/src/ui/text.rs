//! Streaming markdown: fragments in, settled lines out.
//!
//! A paragraph settles when it ends (a blank line, a new block, or the end
//! of the message). Code block lines settle one by one, as they complete.
//! Tables are laid out again each time a row arrives and settle when they
//! end. Until then, [`Md::live`] draws the unsettled part: whole words only,
//! and inline marks styled only once closed.

use super::{Seg, Sty, TLine, clean, g};

#[derive(Debug, Clone, Default)]
pub struct Md {
    /// Columns before the text.
    indent: usize,
    /// The incomplete last line.
    partial: String,
    /// The fence that opened the code block we are in.
    fence: Option<String>,
    /// Lines of the paragraph being written, and its kind.
    para: Vec<String>,
    para_kind: Para,
    table: Vec<String>,
    out: Vec<TLine>,
    /// Whether the last settled line is blank (no double blank lines).
    last_blank: bool,
    any: bool,
    /// The whole message, as markdown, for `/copy`.
    pub source: String,
    /// The last complete code block, for `/copy code`.
    pub last_code: Option<String>,
    code: String,
    pub finished: bool,
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
enum Para {
    #[default]
    Text,
    /// A list item, with the width of its marker.
    Item(usize),
    Quote,
}

impl Md {
    pub fn new(indent: usize) -> Md {
        Md { indent, last_blank: true, ..Default::default() }
    }

    /// Adds a fragment.
    pub fn push(&mut self, frag: &str) {
        if self.finished {
            return;
        }
        let frag = clean(frag);
        self.source.push_str(&frag);
        self.partial.push_str(&frag);
        while let Some(i) = self.partial.find('\n') {
            let line: String = self.partial[..i].trim_end_matches('\r').to_string();
            self.partial.drain(..=i);
            self.line(&line);
        }
    }

    /// The message is complete: settle everything.
    pub fn finish(&mut self) {
        if self.finished {
            return;
        }
        if !self.partial.is_empty() {
            let p = std::mem::take(&mut self.partial);
            self.line(&p);
        }
        if self.fence.is_some() {
            self.fence = None;
            self.last_code = Some(std::mem::take(&mut self.code));
        }
        self.flush_para();
        self.flush_table();
        self.finished = true;
    }

    /// Replaces what was streamed with the complete text (a completed event
    /// wins over the deltas), then finishes. Lines already settled stay.
    pub fn complete_with(&mut self, full: &str) {
        let full = clean(full);
        if let Some(rest) = full.strip_prefix(self.source.as_str()) {
            let rest = rest.to_string();
            self.push(&rest);
        } else if self.source.is_empty() {
            self.push(&full);
        }
        // A completed text that disagrees with the deltas: keep what was
        // settled and finish; the source becomes the server's.
        self.finish();
        self.source = full;
    }

    /// Settled lines since the last call.
    pub fn take(&mut self) -> Vec<TLine> {
        std::mem::take(&mut self.out)
    }

    /// The part not settled yet.
    pub fn live(&self) -> Vec<TLine> {
        let mut lines = Vec::new();
        if !self.table.is_empty() {
            let mut rows = self.table.clone();
            if self.partial.trim_start().starts_with('|') {
                rows.push(self.partial.clone());
            }
            lines.extend(table_lines(&rows, self.indent));
            return lines;
        }
        if self.fence.is_some() {
            if !self.partial.is_empty() {
                lines.push(code_line(&self.partial, self.indent));
            }
            return lines;
        }
        let mut para = self.para.clone();
        let mut kind = self.para_kind;
        // Whole words only: hold back a word still being written.
        let p = self.partial.as_str();
        let shown = match p.rfind(char::is_whitespace) {
            Some(i) => &p[..i],
            None => "",
        };
        if !shown.trim().is_empty() {
            if para.is_empty() {
                let (k, rest) = classify(shown);
                if let Some(k) = k {
                    kind = k;
                    para.push(rest.to_string());
                } else {
                    para.push(shown.to_string());
                }
            } else {
                para.push(shown.to_string());
            }
        }
        if !para.is_empty() {
            lines.push(self.para_line(&para, kind, true));
        }
        lines
    }

    fn emit(&mut self, l: TLine) {
        self.last_blank = l.is_blank();
        self.any = true;
        self.out.push(l);
    }

    fn gap(&mut self) {
        if !self.last_blank && self.any {
            self.emit(TLine::blank());
        }
    }

    fn line(&mut self, l: &str) {
        let t = l.trim_start();
        if let Some(f) = &self.fence {
            if t.starts_with(f.as_str()) && t.trim_end().chars().all(|c| c == f.chars().next().unwrap_or('`')) {
                self.fence = None;
                self.last_code = Some(std::mem::take(&mut self.code));
                return;
            }
            if !self.code.is_empty() {
                self.code.push('\n');
            }
            self.code.push_str(l);
            self.emit(code_line(l, self.indent));
            return;
        }
        if t.starts_with("```") || t.starts_with("~~~") {
            self.flush_para();
            self.flush_table();
            let c = t.chars().next().unwrap_or('`');
            let n = t.chars().take_while(|x| *x == c).count();
            self.fence = Some(c.to_string().repeat(n));
            self.code.clear();
            return;
        }
        if t.is_empty() {
            self.flush_para();
            self.flush_table();
            self.gap();
            return;
        }
        if t.starts_with('|') {
            self.flush_para();
            self.table.push(t.to_string());
            return;
        }
        self.flush_table();
        if t.starts_with('#') {
            self.flush_para();
            let h = t.trim_start_matches('#').trim();
            let mut line = TLine::new(self.indent, self.indent);
            line.push(h, Sty::Heading);
            self.emit(line);
            return;
        }
        if is_rule(t) {
            self.flush_para();
            let line = TLine::row(self.indent).s(g().rule.repeat(20), Sty::Dim);
            self.emit(line);
            return;
        }
        let (k, rest) = classify(l);
        match k {
            Some(k) => {
                self.flush_para();
                self.para_kind = k;
                self.para.push(rest.to_string());
            }
            None => {
                if self.para.is_empty() {
                    self.para_kind = Para::Text;
                }
                self.para.push(t.to_string());
            }
        }
    }

    fn flush_para(&mut self) {
        if self.para.is_empty() {
            return;
        }
        let para = std::mem::take(&mut self.para);
        let l = self.para_line(&para, self.para_kind, false);
        self.para_kind = Para::Text;
        self.emit(l);
    }

    fn para_line(&self, para: &[String], kind: Para, live: bool) -> TLine {
        let joined = para.iter().map(|s| s.trim()).collect::<Vec<_>>().join(" ");
        let mut line = TLine::new(self.indent, self.indent);
        match kind {
            Para::Text => {}
            Para::Item(w) => {
                line.push(format!("{} ", g().bullet), Sty::Dim);
                line.indent = self.indent + w.max(2);
            }
            Para::Quote => {
                line.push("  ", Sty::Dim);
                line.indent = self.indent + 2;
            }
        }
        let base = if kind == Para::Quote { Sty::Dim } else { Sty::Plain };
        line.segs.extend(inline(&joined, base, live));
        line
    }

    fn flush_table(&mut self) {
        if self.table.is_empty() {
            return;
        }
        let rows = std::mem::take(&mut self.table);
        for l in table_lines(&rows, self.indent) {
            self.emit(l);
        }
    }
}

fn is_rule(t: &str) -> bool {
    let t = t.trim();
    t.len() >= 3 && (t.chars().all(|c| c == '-') || t.chars().all(|c| c == '*') || t.chars().all(|c| c == '_'))
}

/// A list item or quote marker at the start of a line.
fn classify(l: &str) -> (Option<Para>, &str) {
    let t = l.trim_start();
    let lead = l.len() - t.len();
    for m in ["- ", "* ", "+ "] {
        if let Some(rest) = t.strip_prefix(m) {
            return (Some(Para::Item(2 + lead.min(6))), rest);
        }
    }
    let digits = t.chars().take_while(|c| c.is_ascii_digit()).count();
    if digits > 0 && digits < 4 {
        let after = &t[digits..];
        if let Some(rest) = after.strip_prefix(". ").or_else(|| after.strip_prefix(") ")) {
            return (Some(Para::Item(digits + 2)), rest);
        }
    }
    if let Some(rest) = t.strip_prefix("> ").or_else(|| t.strip_prefix('>')) {
        return (Some(Para::Quote), rest);
    }
    (None, t)
}

fn code_line(l: &str, indent: usize) -> TLine {
    let text = l.replace('\t', "    ");
    TLine { segs: vec![Seg::new(text, Sty::Block)], lead: indent + 2, indent: indent + 2, nowrap: true }
}

/// Inline markdown: `code`, **bold**, *italic*, [links](url). Marks are
/// styled only when closed. In `live` text an unclosed mark is hidden; in
/// final text it is printed as typed.
pub fn inline(s: &str, base: Sty, live: bool) -> Vec<Seg> {
    let mut out: Vec<Seg> = Vec::new();
    let mut plain = String::new();
    let chars: Vec<char> = s.chars().collect();
    let mut i = 0;
    let flush = |plain: &mut String, out: &mut Vec<Seg>| {
        if !plain.is_empty() {
            out.push(Seg::new(std::mem::take(plain), base));
        }
    };
    while i < chars.len() {
        let c = chars[i];
        let rest = &chars[i..];
        if c == '`' {
            let n = rest.iter().take_while(|x| **x == '`').count();
            if let Some(end) = find_run(&chars, i + n, '`', n) {
                flush(&mut plain, &mut out);
                let inner: String = chars[i + n..end].iter().collect();
                out.push(Seg::new(inner.trim().to_string(), Sty::Code));
                i = end + n;
                continue;
            }
            if live {
                break;
            }
            plain.extend(&chars[i..i + n]);
            i += n;
            continue;
        }
        if (c == '*' || c == '_') && rest.len() >= 2 && rest[1] == c {
            if let Some(end) = find_run(&chars, i + 2, c, 2) {
                flush(&mut plain, &mut out);
                let inner: String = chars[i + 2..end].iter().collect();
                out.push(Seg::new(inner, Sty::Bold));
                i = end + 2;
                continue;
            }
            if live {
                i += 2;
                continue;
            }
            plain.push(c);
            plain.push(c);
            i += 2;
            continue;
        }
        if c == '*' && rest.len() >= 2 && !rest[1].is_whitespace() {
            if let Some(end) = find_run(&chars, i + 1, '*', 1) {
                flush(&mut plain, &mut out);
                let inner: String = chars[i + 1..end].iter().collect();
                out.push(Seg::new(inner, Sty::Italic));
                i = end + 1;
                continue;
            }
            if live {
                i += 1;
                continue;
            }
        }
        if c == '['
            && let Some(close) = chars[i..].iter().position(|x| *x == ']').map(|p| p + i)
            && chars.get(close + 1) == Some(&'(')
            && let Some(paren) = chars[close..].iter().position(|x| *x == ')').map(|p| p + close)
        {
            flush(&mut plain, &mut out);
            let text: String = chars[i + 1..close].iter().collect();
            let url: String = chars[close + 2..paren].iter().collect();
            let mut seg = Seg::new(text, Sty::Link);
            if url.starts_with("http://") || url.starts_with("https://") {
                seg.link = Some(url);
            }
            out.push(seg);
            i = paren + 1;
            continue;
        }
        plain.push(c);
        i += 1;
    }
    flush(&mut plain, &mut out);
    out
}

/// Where the closing run of `n` `c` is, after a non-empty inner part. For
/// emphasis the closer must follow a non-space.
fn find_run(chars: &[char], from: usize, c: char, n: usize) -> Option<usize> {
    let mut j = from + 1;
    while j + n <= chars.len() {
        if chars[j..j + n].iter().all(|x| *x == c) && (c == '`' || !chars[j - 1].is_whitespace()) {
            return Some(j);
        }
        j += 1;
    }
    None
}

fn table_lines(rows: &[String], indent: usize) -> Vec<TLine> {
    let cells: Vec<Vec<String>> = rows
        .iter()
        .filter(|r| !r.chars().all(|c| matches!(c, '|' | '-' | ':' | ' ')))
        .map(|r| {
            let t = r.trim().trim_start_matches('|').trim_end_matches('|');
            t.split('|').map(|c| c.trim().to_string()).collect()
        })
        .collect();
    let cols = cells.iter().map(Vec::len).max().unwrap_or(0);
    let mut widths = vec![0usize; cols];
    for r in &cells {
        for (i, c) in r.iter().enumerate() {
            widths[i] = widths[i].max(super::width(&strip_marks(c)));
        }
    }
    cells
        .iter()
        .enumerate()
        .map(|(n, r)| {
            let mut l = TLine::row(indent);
            for (i, w) in widths.iter().enumerate() {
                let c = r.get(i).map(|c| strip_marks(c)).unwrap_or_default();
                let pad = w - super::width(&c);
                let sty = if n == 0 { Sty::Bold } else { Sty::Plain };
                l.push(format!("{c}{}", " ".repeat(pad)), sty);
                if i + 1 < widths.len() {
                    l.push("  ", Sty::Plain);
                }
            }
            l
        })
        .collect()
}

fn strip_marks(s: &str) -> String {
    s.replace("**", "").replace('`', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn text(lines: &[TLine]) -> Vec<String> {
        lines.iter().map(|l| l.plain()).collect()
    }

    #[test]
    fn paragraphs_settle_when_they_end() {
        let mut m = Md::new(6);
        m.push("I'll run the te");
        assert!(m.take().is_empty());
        assert_eq!(text(&m.live()), vec!["      I'll run the"]);
        m.push("st a few times.\n\nThe flake");
        assert_eq!(text(&m.take()), vec!["      I'll run the test a few times.", ""]);
        m.finish();
        assert_eq!(text(&m.take()), vec!["      The flake"]);
    }

    #[test]
    fn inline_marks_wait_for_their_close() {
        let segs = inline("run **npm", Sty::Plain, true);
        assert_eq!(segs.iter().map(|s| s.text.as_str()).collect::<String>(), "run npm");
        assert!(segs.iter().all(|s| s.sty == Sty::Plain));
        let segs = inline("run **npm** and `x`", Sty::Plain, false);
        assert_eq!(segs[1], Seg::new("npm", Sty::Bold));
        assert_eq!(segs[3], Seg::new("x", Sty::Code));
        let segs = inline("a * b", Sty::Plain, false);
        assert_eq!(segs.iter().map(|s| s.text.as_str()).collect::<String>(), "a * b");
    }

    #[test]
    fn code_blocks_stream_line_by_line_and_never_wrap() {
        let mut m = Md::new(6);
        m.push("```sh\nnpm test -- segment\n");
        let out = m.take();
        assert_eq!(out.len(), 1);
        assert!(out[0].nowrap);
        assert_eq!(out[0].segs[0].sty, Sty::Block);
        m.push("```\n");
        assert_eq!(m.last_code.as_deref(), Some("npm test -- segment"));
    }

    #[test]
    fn tables_lay_out_when_they_end() {
        let mut m = Md::new(0);
        m.push("| a | bb |\n|---|---|\n| ccc | d |\n");
        assert!(m.take().is_empty());
        assert_eq!(m.live().len(), 2);
        m.push("\n");
        assert_eq!(text(&m.take())[..2], ["a    bb".to_string(), "ccc  d ".to_string()]);
    }

    #[test]
    fn complete_text_wins() {
        let mut m = Md::new(0);
        m.push("Hello wor");
        m.complete_with("Hello world.");
        assert_eq!(text(&m.take()), vec!["Hello world."]);
        m.push("ignored");
        assert!(m.take().is_empty());
    }
}
