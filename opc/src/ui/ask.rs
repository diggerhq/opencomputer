//! An open ask, drawn inline above the prompt, and its keys.

use crossterm::event::{KeyCode, KeyEvent, KeyModifiers};
use serde_json::{Value, json};

use super::prompt::{Edit, Editor};
use super::{Sty, TLine, clean, first_line, g, truncate};
use crate::api::types::Ask;

#[derive(Debug, Clone, PartialEq)]
pub enum AskOut {
    None,
    /// Back to the prompt line; the ask stays open.
    ToPrompt,
    /// `asks.answer` with this body.
    Answer(Value),
    /// `asks.dismiss`.
    Dismiss,
    /// Open the dashboard's form.
    Web,
    /// Show the full input.
    Details,
}

#[derive(Debug, Clone)]
enum Stage {
    Main,
    /// Typing a reason (approval `e`) or what to change (plan `e`).
    Reason(Editor),
    /// Typing on "Something else…".
    Other(Editor),
}

#[derive(Debug, Clone)]
pub struct AskUi {
    pub ask: Ask,
    stage: Stage,
    /// The question shown, of several.
    q: usize,
    sel: usize,
    /// Toggled choices of a multi-select question.
    toggled: Vec<usize>,
    answers: Vec<Value>,
}

pub fn is_plan(ask: &Ask) -> bool {
    ask.kind == "approval" && ask.approval.as_ref().is_some_and(|a| a.tool_name == "ExitPlanMode")
}

/// The plan's text, from the approval's input.
pub fn plan_text(ask: &Ask) -> String {
    ask.approval.as_ref().and_then(|a| a.input.get("plan").and_then(Value::as_str).map(str::to_string)).unwrap_or_default()
}

fn plan_steps(plan: &str) -> usize {
    plan.lines()
        .map(str::trim_start)
        .filter(|l| {
            let d = l.chars().take_while(char::is_ascii_digit).count();
            (d > 0 && l[d..].starts_with(['.', ')'])) || l.starts_with("- ") || l.starts_with("* ")
        })
        .count()
}

/// The rule `a` allows: `terraform plan *` from `Bash(terraform plan *)`.
fn rule_words(rule: &str) -> String {
    match (rule.find('('), rule.ends_with(')')) {
        (Some(i), true) => rule[i + 1..rule.len() - 1].to_string(),
        _ => rule.to_string(),
    }
}

impl AskUi {
    pub fn new(ask: Ask) -> AskUi {
        AskUi { ask, stage: Stage::Main, q: 0, sel: 0, toggled: Vec::new(), answers: Vec::new() }
    }

    pub fn id(&self) -> &str {
        &self.ask.id
    }

    /// Typing into a line inside the ask (keys should not be taken as
    /// shortcuts).
    pub fn typing(&self) -> bool {
        !matches!(self.stage, Stage::Main)
    }

    pub fn key(&mut self, k: &KeyEvent) -> AskOut {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        if k.code == KeyCode::Esc {
            if matches!(self.stage, Stage::Main) {
                return AskOut::ToPrompt;
            }
            self.stage = Stage::Main;
            return AskOut::None;
        }
        if ctrl && k.code == KeyCode::Char('o') {
            return AskOut::Details;
        }
        match &mut self.stage {
            Stage::Reason(ed) => {
                if let Edit::Submit(t) = ed.key(k) {
                    let t = t.trim().to_string();
                    let mut body = json!({"decision": "deny"});
                    if !t.is_empty() {
                        body["message"] = json!(t);
                    }
                    return AskOut::Answer(body);
                }
                return AskOut::None;
            }
            Stage::Other(ed) => {
                if let Edit::Submit(t) = ed.key(k) {
                    let t = t.trim().to_string();
                    if t.is_empty() {
                        return AskOut::None;
                    }
                    self.stage = Stage::Main;
                    return self.answer_question(Vec::new(), Some(t));
                }
                return AskOut::None;
            }
            Stage::Main => {}
        }
        match self.ask.kind.as_str() {
            "approval" if is_plan(&self.ask) => match k.code {
                KeyCode::Char('y') => AskOut::Answer(json!({"decision": "allow", "mode": "default"})),
                KeyCode::Char('A') => AskOut::Answer(json!({"decision": "allow", "mode": "acceptEdits"})),
                KeyCode::Char('n') => AskOut::Answer(json!({"decision": "deny"})),
                KeyCode::Char('e') => {
                    self.stage = Stage::Reason(Editor::new(vec![]));
                    AskOut::None
                }
                _ => AskOut::None,
            },
            "approval" => match k.code {
                KeyCode::Char('y') => AskOut::Answer(json!({"decision": "allow"})),
                KeyCode::Char('n') => AskOut::Answer(json!({"decision": "deny"})),
                KeyCode::Char('a') if self.ask.approval.as_ref().is_some_and(|a| a.always_allows.is_some()) => AskOut::Answer(json!({"decision": "always"})),
                KeyCode::Char('e') => {
                    self.stage = Stage::Reason(Editor::new(vec![]));
                    AskOut::None
                }
                _ => AskOut::None,
            },
            "question" => self.question_key(k),
            // Answered in Slack only; here it can only be skipped.
            "secret" => match k.code {
                KeyCode::Char('x') => AskOut::Dismiss,
                _ => AskOut::None,
            },
            _ => match k.code {
                KeyCode::Char('w') => AskOut::Web,
                KeyCode::Char('d') if ctrl => AskOut::Dismiss,
                _ => AskOut::None,
            },
        }
    }

    fn question(&self) -> Option<&crate::api::types::Question> {
        self.ask.question.as_ref().and_then(|q| q.questions.get(self.q))
    }

    fn question_key(&mut self, k: &KeyEvent) -> AskOut {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let Some(q) = self.question().cloned() else {
            return if ctrl && k.code == KeyCode::Char('d') { AskOut::Dismiss } else { AskOut::None };
        };
        let n = q.options.len() + 1; // + Something else…
        let other = n - 1;
        match k.code {
            KeyCode::Char('d') if ctrl => return AskOut::Dismiss,
            KeyCode::Up => self.sel = (self.sel + n - 1) % n,
            KeyCode::Down => self.sel = (self.sel + 1) % n,
            KeyCode::Char(' ') if q.multi_select && self.sel < other => {
                match self.toggled.iter().position(|x| *x == self.sel) {
                    Some(i) => {
                        self.toggled.remove(i);
                    }
                    None => self.toggled.push(self.sel),
                }
            }
            KeyCode::Char(c) if c.is_ascii_digit() && c != '0' && !ctrl => {
                let i = c as usize - '1' as usize;
                if i < q.options.len() {
                    if q.multi_select {
                        self.sel = i;
                        match self.toggled.iter().position(|x| *x == i) {
                            Some(p) => {
                                self.toggled.remove(p);
                            }
                            None => self.toggled.push(i),
                        }
                    } else {
                        return self.answer_question(vec![q.options[i].label.clone()], None);
                    }
                }
            }
            KeyCode::Enter => {
                if self.sel == other {
                    self.stage = Stage::Other(Editor::new(vec![]));
                    return AskOut::None;
                }
                let picks: Vec<String> = if q.multi_select {
                    let mut t = self.toggled.clone();
                    if t.is_empty() {
                        t.push(self.sel);
                    }
                    t.sort();
                    t.iter().filter_map(|i| q.options.get(*i)).map(|o| o.label.clone()).collect()
                } else {
                    q.options.get(self.sel).map(|o| vec![o.label.clone()]).unwrap_or_default()
                };
                return self.answer_question(picks, None);
            }
            KeyCode::Char(c) if self.sel == other && !ctrl => {
                let mut ed = Editor::new(vec![]);
                ed.insert(&c.to_string());
                self.stage = Stage::Other(ed);
            }
            _ => {}
        }
        AskOut::None
    }

    /// Records this question's answer; after the last, sends them all.
    fn answer_question(&mut self, choices: Vec<String>, text: Option<String>) -> AskOut {
        let qid = self.question().map(|q| q.id.clone()).unwrap_or_default();
        self.answers.push(json!({"questionId": qid, "choices": choices, "text": text}));
        let total = self.ask.question.as_ref().map(|q| q.questions.len()).unwrap_or(0);
        self.q += 1;
        self.sel = 0;
        self.toggled.clear();
        if self.q >= total {
            return AskOut::Answer(json!({"answers": std::mem::take(&mut self.answers)}));
        }
        AskOut::None
    }

    /// The ask's lines; `focused` when it has the keyboard. The cursor is
    /// returned when a line inside the ask is being typed in.
    pub fn render(&self, w: usize, focused: bool) -> (Vec<TLine>, Option<(usize, usize)>) {
        let mid = format!(" {} ", g().mid);
        let mut out = Vec::new();
        let head = |l: TLine| l.s("? ", Sty::Warn);
        let keys = |s: &str| TLine::row(4).s(s.to_string(), if focused { Sty::Plain } else { Sty::Dim });
        match self.ask.kind.as_str() {
            "approval" if is_plan(&self.ask) => {
                let steps = plan_steps(&plan_text(&self.ask));
                let mut l = head(TLine::row(2)).s("Plan ready", Sty::Bold);
                if steps > 0 {
                    l.push(format!("{mid}{}", super::plural(steps, "step")), Sty::Dim);
                }
                out.push(l);
                out.push(keys("[y] approve   [A] approve, accept edits   [n] keep planning   [e] say what to change"));
            }
            "approval" => {
                let a = self.ask.approval.clone().unwrap_or_default();
                let mut l = head(TLine::row(2)).s(super::model::tool_name(&a.tool_name), Sty::Bold);
                let title = if a.title.trim().is_empty() { super::model::step_title(&a.tool_name, &json!({"input": a.input})) } else { a.title.clone() };
                l.push(format!("  {}", truncate(first_line(&clean(&title)), w.saturating_sub(12))), Sty::Plain);
                out.push(l);
                let mut why = Vec::new();
                if let Some(cwd) = a.input.get("cwd").and_then(Value::as_str) {
                    why.push(format!("in {}", clean(cwd)));
                }
                why.push("wants approval".to_string());
                out.push(TLine::row(4).s(why.join(&mid), Sty::Dim));
                out.push(keys("[y] allow   [n] deny   [e] deny and say why"));
                if let Some(r) = &a.always_allows {
                    out.push(keys(&format!("[a] allow \"{}\" this session", clean(&rule_words(r)))));
                }
            }
            "question" => {
                let total = self.ask.question.as_ref().map(|q| q.questions.len()).unwrap_or(0);
                if let Some(q) = self.question() {
                    let mut l = head(TLine::row(2)).s(clean(&q.text), Sty::Bold);
                    if total > 1 {
                        l.push(format!("{mid}{}/{total}", self.q + 1), Sty::Dim);
                    }
                    out.push(l);
                    let n = q.options.len();
                    for (i, o) in q.options.iter().enumerate() {
                        let mark = if i == self.sel && focused { format!("{} ", g().select) } else { "  ".into() };
                        let tick = if q.multi_select { if self.toggled.contains(&i) { "[x] " } else { "[ ] " } } else { "" };
                        let mut l = TLine::row(4).s(mark, Sty::Accent).s(format!("{tick}{}", clean(&o.label)), if i == self.sel { Sty::Bold } else { Sty::Plain });
                        if let Some(d) = o.description.as_deref().filter(|d| !d.is_empty()) {
                            l.push(format!("   {}", first_line(&clean(d))), Sty::Dim);
                        }
                        out.push(l);
                    }
                    let mark = if self.sel == n && focused { format!("{} ", g().select) } else { "  ".into() };
                    out.push(TLine::row(4).s(mark, Sty::Accent).s(format!("Something else{}", g().ellipsis), Sty::Dim));
                    let space = if q.multi_select { " · space toggle" } else { "" };
                    out.push(TLine::row(4).s(format!("{}{} move · enter choose{space} · tab to the prompt line", g().up, g().down), Sty::Dim));
                }
            }
            "secret" => {
                let s = self.ask.secret.clone().unwrap_or_default();
                out.push(head(TLine::row(2)).s(format!("Secret {} needed", clean(&s.name)), Sty::Bold));
                if let Some(p) = s.purpose.as_deref().filter(|p| !p.is_empty()) {
                    out.push(TLine::new(4, 5).s(format!("\"{}\"", clean(p)), Sty::Dim));
                }
                out.push(keys("answered in Slack   [x] skip"));
            }
            other => {
                out.push(head(TLine::row(2)).s(format!("{} {}", if other.is_empty() { "ask" } else { other }, self.ask.describe()), Sty::Bold));
                out.push(keys("[w] answer on the dashboard"));
            }
        }
        let mut cursor = None;
        match &self.stage {
            Stage::Reason(ed) | Stage::Other(ed) => {
                let label = match &self.stage {
                    Stage::Reason(_) if is_plan(&self.ask) => "what to change: ",
                    Stage::Reason(_) => "why: ",
                    _ => "answer: ",
                };
                let (rows, (r, c)) = ed.render(w.saturating_sub(4 + label.len()), "");
                let row0 = out.len();
                for (i, row) in rows.into_iter().enumerate() {
                    let mut l = TLine::row(4).s(if i == 0 { label.to_string() } else { " ".repeat(label.len()) }, Sty::Dim);
                    // Drop the editor's own `> `.
                    l.segs.extend(row.segs.into_iter().skip(1));
                    out.push(l);
                }
                cursor = Some((row0 + r, 4 + label.len() + c.saturating_sub(2)));
            }
            Stage::Main => {}
        }
        (out, cursor)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn k(c: char) -> KeyEvent {
        KeyEvent::new(KeyCode::Char(c), KeyModifiers::NONE)
    }
    fn key(code: KeyCode) -> KeyEvent {
        KeyEvent::new(code, KeyModifiers::NONE)
    }
    fn ask(v: Value) -> Ask {
        serde_json::from_value(v).unwrap()
    }

    #[test]
    fn approvals_allow_deny_and_always() {
        let a = ask(json!({"id": "ak_1", "kind": "approval", "status": "open", "approval": {"toolName": "Bash", "title": "terraform plan -out=staging.tfplan", "input": {}, "alwaysAllows": "Bash(terraform plan *)"}}));
        let mut ui = AskUi::new(a);
        let (lines, _) = ui.render(80, true);
        let text: Vec<String> = lines.iter().map(|l| l.plain()).collect();
        assert_eq!(text[0], "  ? Bash  terraform plan -out=staging.tfplan");
        assert_eq!(text[3], "    [a] allow \"terraform plan *\" this session");
        assert_eq!(ui.key(&k('a')), AskOut::Answer(json!({"decision": "always"})));
        ui.key(&k('e'));
        for c in "use staging".chars() {
            ui.key(&k(c));
        }
        assert_eq!(ui.key(&key(KeyCode::Enter)), AskOut::Answer(json!({"decision": "deny", "message": "use staging"})));
    }

    #[test]
    fn plans_offer_a_mode() {
        let a = ask(json!({"id": "ak_2", "kind": "approval", "status": "open", "approval": {"toolName": "ExitPlanMode", "title": "plan", "input": {"plan": "1. a\n2. b\n3. c\n4. d"}}}));
        let mut ui = AskUi::new(a);
        assert_eq!(ui.render(100, true).0[0].plain(), "  ? Plan ready · 4 steps");
        assert_eq!(ui.key(&k('A')), AskOut::Answer(json!({"decision": "allow", "mode": "acceptEdits"})));
        assert_eq!(ui.key(&k('y')), AskOut::Answer(json!({"decision": "allow", "mode": "default"})));
        assert_eq!(ui.key(&k('n')), AskOut::Answer(json!({"decision": "deny"})));
    }

    #[test]
    fn questions_choose_toggle_and_type() {
        let a = ask(json!({"id": "ak_3", "kind": "question", "status": "open", "question": {"questions": [
            {"id": "q1", "text": "Which fix?", "multiSelect": false, "options": [{"label": "Wait for the debounce"}, {"label": "Await timers"}]},
            {"id": "q2", "text": "Which files?", "multiSelect": true, "options": [{"label": "a"}, {"label": "b"}, {"label": "c"}]},
            {"id": "q3", "text": "Anything else?", "multiSelect": false, "options": [{"label": "no"}]}]}}));
        let mut ui = AskUi::new(a);
        assert_eq!(ui.key(&k('2')), AskOut::None);
        ui.key(&k(' '));
        ui.key(&key(KeyCode::Down));
        ui.key(&key(KeyCode::Down));
        ui.key(&k(' '));
        assert_eq!(ui.key(&key(KeyCode::Enter)), AskOut::None);
        ui.key(&key(KeyCode::Down));
        ui.key(&k('h'));
        ui.key(&k('i'));
        let out = ui.key(&key(KeyCode::Enter));
        assert_eq!(out, AskOut::Answer(json!({"answers": [
            {"questionId": "q1", "choices": ["Await timers"], "text": null},
            {"questionId": "q2", "choices": ["a", "c"], "text": null},
            {"questionId": "q3", "choices": [], "text": "hi"}]})));
    }

    #[test]
    fn secrets_are_answered_in_slack_and_only_skipped_here() {
        let a = ask(json!({"id": "ak_4", "kind": "secret", "status": "open", "secret": {"name": "STRIPE_API_KEY", "purpose": "tests", "file": false}}));
        let mut ui = AskUi::new(a);
        let text: Vec<String> = ui.render(80, true).0.iter().map(|l| l.plain()).collect();
        assert_eq!(text, ["  ? Secret STRIPE_API_KEY needed", "    \"tests\"", "    answered in Slack   [x] skip"]);
        for c in [key(KeyCode::Enter), k('w'), k('s')] {
            assert_eq!(ui.key(&c), AskOut::None);
        }
        assert!(!ui.typing());
        assert_eq!(ui.key(&k('x')), AskOut::Dismiss);
    }
}
