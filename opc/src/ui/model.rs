//! The session screen's state, as a pure reducer.
//!
//! Recorded events, deltas, attach results and the results of our own sends
//! go in. Out come settled transcript lines ([`Model::take_out`]), effects
//! for the app to carry out ([`Model::take_effects`]), and the live area
//! and status line, drawn from the state at any moment. Nothing here does
//! IO or reads the clock: every input carries `now`, in milliseconds.
//!
//! Server data is read leniently: types are open strings and any field may
//! be missing, which only ever makes a line plainer.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

use super::text::Md;
use super::{Seg, Sty, TLine, clean, dur, first_line, g, plural, spinner, timer, tokens, truncate};
use crate::api::types::{Actor, Ask, Capabilities, Delta, Event, Settings, Subagent, Turn};
use crate::wire::AttachInfo;

/// Columns before a person's message (after the `you` gutter).
pub const TEXT_INDENT: usize = 6;
/// The agent's reply: at the step column, beside its tool rows rather than under one (they are its own steps).
pub const REPLY_INDENT: usize = 2;
/// A running turn notifies when it ends only if it took longer than this.
const NOTIFY_AFTER_MS: i64 = 10_000;
/// Reasoning shorter than this is not mentioned in a run.
const THOUGHT_MIN_MS: u64 = 1_500;
/// How long a fact stays on the right of the status line.
const FACT_MS: i64 = 6_000;
/// After an interrupt settles, wait this long for background subagents the
/// harness stops on its own before saying any still run.
const INTERRUPT_SETTLE_MS: i64 = 1_500;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Effect {
    /// Tell the person, if they are looking elsewhere.
    Notify(String),
    /// Put this text back into the prompt line.
    Restore(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Conn {
    Connecting,
    Online,
    Offline { retry_at: i64 },
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StepState {
    /// `tool.preparing`: the model is still writing the call's input.
    Preparing,
    Running,
    Ok,
    /// Returned an error the agent moved past.
    Failed,
    /// Cut off by the turn ending.
    Cut,
}

#[derive(Debug, Clone)]
pub struct Step {
    pub call_id: String,
    pub tool: String,
    pub title: String,
    pub state: StepState,
    pub start: i64,
    paused0: i64,
    pub end: Option<i64>,
    pub dur_ms: Option<u64>,
    pub added: u64,
    pub removed: u64,
    /// `tool.preparing`: what is being written, and how many lines so far.
    pub lines: Option<u64>,
    /// The subagent this call launched.
    pub subagent: Option<String>,
    /// The last lines of `tool.delta` output.
    pub output: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct Run {
    steps: Vec<Step>,
    thought_ms: u64,
}

#[derive(Debug, Clone)]
struct Reasoning {
    block: String,
    start: i64,
    paused0: i64,
    text: String,
}

#[derive(Debug, Clone)]
struct TurnLive {
    id: String,
    start: i64,
    paused0: i64,
    /// The last thing that happened in the turn, for the "thinking" timer.
    activity: i64,
    activity_paused0: i64,
    any: bool,
    replay: bool,
    text: Option<(String, Md)>,
    reasoning: Option<Reasoning>,
    run: Run,
    steps: usize,
    files: BTreeMap<String, (u64, u64)>,
    /// Messages steered into this turn that the agent has not read yet.
    steered_unread: usize,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum OutState {
    Sending,
    Pending,
    /// Accepted into the running turn; waiting for the agent to read it.
    Steered { turn_id: String, seq: u64 },
}

/// A message typed here that is not in the transcript yet.
#[derive(Debug, Clone)]
pub struct Outgoing {
    pub id: u64,
    pub text: String,
    pub queue: bool,
    pub state: OutState,
}

/// A message waiting to run as its own turn.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Queued {
    pub turn_id: String,
    pub text: String,
    /// `None` for ours.
    pub who: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Sub {
    pub sa: Subagent,
    pub start: i64,
    pub end: Option<i64>,
}

impl Sub {
    pub fn elapsed(&self, now: i64) -> u64 {
        if let Some(d) = self.sa.duration_ms.filter(|_| !self.sa.is_running()) {
            return d;
        }
        (self.end.unwrap_or(now) - self.start).max(0) as u64
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Todo {
    pub content: String,
    pub status: String,
    pub active: Option<String>,
}

#[derive(Debug, Clone)]
pub struct Model {
    pub session_id: String,
    pub title: String,
    pub settings: Settings,
    pub status: String,
    pub caps: Option<Capabilities>,
    /// Our member id, when known: our messages are `you`.
    pub me: Option<String>,
    pub read_only: bool,
    pub conn: Conn,
    /// `starting your computer`, `starting`, `resuming`.
    pub runtime: Option<String>,
    pub compacting: bool,
    pub rate_limited_until: Option<i64>,
    pub context: Option<(u64, u64)>,
    pub slow: bool,
    pub show_reasoning: bool,
    pub asks: Vec<Ask>,
    pub subs: Vec<Sub>,
    pub todos: Vec<Todo>,
    pub queued: Vec<Queued>,
    pub outgoing: Vec<Outgoing>,
    /// The agent's last message, as markdown, and its last code block.
    pub last_text: Option<String>,
    pub last_code: Option<String>,
    /// Every recorded event seen, for the details view.
    pub events: Vec<Event>,
    pub last_seq: u64,
    /// Events up to this `seq` are catch-up, not news: no notifications.
    pub catchup_seq: u64,
    /// Number of turns the server summarized without events.
    pub attached_once: bool,
    out: Vec<TLine>,
    effects: Vec<Effect>,
    fact: Option<(String, i64)>,
    turn: Option<TurnLive>,
    next_out: u64,
    /// Turns with a `message.received`, and who wrote it.
    received: HashMap<String, (Option<String>, String)>,
    todo_printed: HashSet<String>,
    paused_total: i64,
    paused_since: Option<i64>,
    /// A message steered into a turn that ended before reading it starts
    /// the next turn: that turn is not self-started.
    carried_over: usize,
    /// Turns started in this model: the first one seen may have lost its
    /// message to the attach's cut, so it gets no `agent` header.
    turns_seen: usize,
    /// Turns our own message started, shown from the send's response: its
    /// `message.received` echo is not printed again.
    echoed: HashSet<String>,
    interrupted_at: Option<i64>,
    header: Option<String>,
    /// Asks declined by a message, and the message (A6).
    declined_by: HashMap<String, String>,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(clean)
}

fn u(v: &Value, k: &str) -> Option<u64> {
    v.get(k).and_then(Value::as_u64)
}

/// Where a person wrote from, for labels: `slack`, `web`, `opc`.
fn via_label(a: &Actor) -> String {
    let v = a.via.trim();
    if v.is_empty() { a.client.clone().unwrap_or_default() } else { v.to_string() }
}

/// `in Slack`, `on the dashboard`, `in a terminal`.
fn via_phrase(a: &Actor) -> String {
    match via_label(a).as_str() {
        "slack" => "in Slack".into(),
        "web" | "dashboard" => "on the dashboard".into(),
        "opc" | "cli" => "in a terminal".into(),
        "" => String::new(),
        other => format!("via {other}"),
    }
}

/// A tool's name for people: `mcp__linear__create_issue` → `linear create_issue`.
pub fn tool_name(t: &str) -> String {
    match t.strip_prefix("mcp__") {
        Some(rest) => rest.replacen("__", " ", 1),
        None if t.is_empty() => "tool".into(),
        None => t.to_string(),
    }
}

/// The title of a step: Bash steps use the command's description (O4).
pub fn step_title(tool: &str, data: &Value) -> String {
    let input = data.get("input").unwrap_or(&Value::Null);
    if tool == "Bash"
        && let Some(d) = s(input, "description").filter(|d| !d.trim().is_empty())
    {
        return first_line(&d).to_string();
    }
    if let Some(t) = s(data, "title").filter(|t| !t.trim().is_empty()) {
        return first_line(&t).to_string();
    }
    for k in ["file_path", "path", "pattern", "command", "url", "query", "description"] {
        if let Some(v) = s(input, k) {
            return first_line(&v).to_string();
        }
    }
    String::new()
}

fn is_todo_tool(t: &str) -> bool {
    t == "TodoWrite"
}

/// The `+12 −3` of a change.
fn change(added: u64, removed: u64) -> String {
    format!("+{added} {}{removed}", g().minus)
}

impl Model {
    pub fn new(session_id: &str, read_only: bool) -> Model {
        Model {
            session_id: session_id.to_string(),
            title: String::new(),
            settings: Settings::default(),
            status: String::new(),
            caps: None,
            me: None,
            read_only,
            conn: Conn::Connecting,
            runtime: None,
            compacting: false,
            rate_limited_until: None,
            context: None,
            slow: false,
            show_reasoning: false,
            asks: Vec::new(),
            subs: Vec::new(),
            todos: Vec::new(),
            queued: Vec::new(),
            outgoing: Vec::new(),
            last_text: None,
            last_code: None,
            events: Vec::new(),
            last_seq: 0,
            catchup_seq: 0,
            attached_once: false,
            out: Vec::new(),
            effects: Vec::new(),
            fact: None,
            turn: None,
            next_out: 1,
            received: HashMap::new(),
            todo_printed: HashSet::new(),
            paused_total: 0,
            paused_since: None,
            carried_over: 0,
            turns_seen: 0,
            echoed: HashSet::new(),
            interrupted_at: None,
            header: None,
            declined_by: HashMap::new(),
        }
    }

    // ---- output -------------------------------------------------------

    /// Lines are waiting to be printed.
    pub fn has_out(&self) -> bool {
        !self.out.is_empty()
    }

    pub fn take_out(&mut self) -> Vec<TLine> {
        std::mem::take(&mut self.out)
    }

    pub fn take_effects(&mut self) -> Vec<Effect> {
        std::mem::take(&mut self.effects)
    }

    pub fn print(&mut self, l: TLine) {
        self.out.push(l);
    }

    /// A dim note at the step indent: `  model: opus → sonnet`.
    pub fn note(&mut self, text: &str) {
        self.out.push(TLine::new(2, 4).s(text, Sty::Dim));
    }

    pub fn error(&mut self, text: &str) {
        self.out.push(TLine::new(2, 4).s(format!("{} ", g().fail), Sty::Err).s(text, Sty::Plain));
    }

    pub fn set_fact(&mut self, text: impl Into<String>, now: i64) {
        self.fact = Some((text.into(), now + FACT_MS));
    }

    pub fn set_fact_for(&mut self, text: impl Into<String>, until: i64) {
        self.fact = Some((text.into(), until));
    }

    fn notify(&mut self, replay: bool, text: String) {
        if !replay {
            self.effects.push(Effect::Notify(text));
        }
    }

    fn is_replay(&self, ev: &Event) -> bool {
        ev.seq() != 0 && ev.seq() <= self.catchup_seq
    }

    fn stamp(&self, ev: &Event, now: i64) -> i64 {
        if self.is_replay(ev) { ev.created_at().and_then(super::parse_time).unwrap_or(now) } else { now }
    }

    // ---- time spent waiting on an ask (O6) ---------------------------

    fn paused(&self, now: i64) -> i64 {
        self.paused_total + self.paused_since.map(|s| (now - s).max(0)).unwrap_or(0)
    }

    /// Time since `start`, not counting time an ask was open.
    fn waited(&self, start: i64, paused0: i64, now: i64) -> u64 {
        ((now - start) - (self.paused(now) - paused0)).max(0) as u64
    }

    fn update_pause(&mut self, now: i64) {
        let open = self.asks.iter().any(Ask::is_open);
        match (open, self.paused_since) {
            (true, None) => self.paused_since = Some(now),
            (false, Some(s)) => {
                self.paused_total += (now - s).max(0);
                self.paused_since = None;
            }
            _ => {}
        }
    }

    // ---- the session --------------------------------------------------

    /// The model's name for people: the capability's name, else the id.
    pub fn model_name(&self) -> String {
        let id = self.settings.model.clone().unwrap_or_default();
        if let Some(c) = &self.caps
            && let Some(m) = c.models.iter().find(|m| m.id == id)
            && let Some(n) = &m.name
        {
            return n.to_lowercase();
        }
        pretty_model(&id)
    }

    /// `▸ flaky test in segment.test.ts · 7f3a · opus 5.5 · high · accept edits`: the title
    /// stands out, the rest is the session's settings, dim. The usual permission mode is left out.
    pub fn header_line(&self) -> TLine {
        let mid = format!(" {} ", g().mid);
        let mut parts = vec![crate::ids::short(&self.session_id).to_string()];
        let m = self.model_name();
        if !m.is_empty() {
            parts.push(m);
        }
        if let Some(e) = &self.settings.effort {
            parts.push(e.clone());
        }
        if let Some(s) = self.settings.speed.as_deref().and_then(speed_label) {
            parts.push(s);
        }
        if let Some(m) = self.settings.mode.as_deref().and_then(mode_label) {
            parts.push(m);
        }
        let mut l = TLine::row(0).s(format!("{} ", g().head), Sty::Accent);
        let title = !self.title.trim().is_empty();
        if title {
            l.push(self.title.clone(), Sty::Bold);
        }
        for (i, p) in parts.into_iter().enumerate() {
            if title || i > 0 {
                l.push(mid.clone(), Sty::Dim);
            }
            l.push(p, Sty::Dim);
        }
        l
    }

    /// Prints the header if it changed, once the session has a title.
    fn maybe_header(&mut self) {
        if self.title.trim().is_empty() || self.title == "Untitled" {
            return;
        }
        let l = self.header_line();
        let p = l.plain();
        if self.header.as_deref() != Some(p.as_str()) {
            self.header = Some(p);
            self.out.push(l);
        }
    }

    /// An attach result: the session as it is now. Called again after each
    /// reconnect.
    pub fn attached(&mut self, info: &AttachInfo, now: i64) {
        let s = &info.session;
        self.title = clean(&s.title);
        self.settings = s.settings.clone();
        self.status = s.status.clone();
        if info.capabilities.is_some() {
            self.caps = info.capabilities.clone();
        }
        // Either may be null (the type is Option<u64> upstream).
        if let Some(c) = &s.context
            && let (Some(u), Some(w)) = (c.used_tokens, c.window_tokens)
        {
            self.context = Some((u, w));
        }
        self.catchup_seq = self.catchup_seq.max(s.last_seq);
        self.conn = Conn::Online;
        self.runtime = match s.status.as_str() {
            "starting" => Some("starting".into()),
            _ => None,
        };
        // Asks and subagents as they are now; events may refine them.
        self.asks = s.asks.iter().filter(|a| a.is_open()).cloned().collect();
        for sa in &s.subagents {
            self.upsert_sub(sa.clone(), now);
        }
        // Subagents we thought were running and the server no longer lists
        // ended while we were away; their `subagent.ended` follows in the
        // catch-up, or they are dropped here when it does not.
        if self.attached_once {
            let running: HashSet<&str> = s.subagents.iter().map(|x| x.id.as_str()).collect();
            for sub in &mut self.subs {
                if sub.sa.is_running() && !running.contains(sub.sa.id.as_str()) && sub.sa.created_at.is_some() {
                    // Leave it: catch-up events will end it.
                }
            }
        }
        self.update_pause(now);
        self.attached_once = true;
        self.maybe_header();
    }

    /// The turns before the ones printed in full: one line each for the
    /// last 10, and one line for the rest.
    pub fn earlier(&mut self, turns_newest_first: &[Turn]) {
        if turns_newest_first.is_empty() {
            return;
        }
        let shown = turns_newest_first.len().min(10);
        let rest = turns_newest_first.len() - shown;
        if rest > 0 {
            self.out.push(TLine::row(2).s(format!("{} {} earlier turns {} Ctrl+O for all", g().rule.repeat(2), rest, g().mid), Sty::Dim));
        }
        for t in turns_newest_first[..shown].iter().rev() {
            let l = self.turn_summary(t);
            self.out.push(l);
        }
    }

    fn turn_summary(&self, t: &Turn) -> TLine {
        let who = match &t.author {
            Some(a) if Some(&a.id) == self.me.as_ref() => "you".to_string(),
            Some(a) if !a.name.is_empty() => a.name.clone(),
            _ if t.trigger.as_deref() == Some("subagent") || t.input.is_none() => "agent".to_string(),
            _ => "you".to_string(),
        };
        let input = t.input.as_deref().map(|i| first_line(&clean(i)).to_string()).unwrap_or_default();
        let mark = match t.status.as_str() {
            "completed" => g().ok,
            "failed" | "cancelled" => g().fail,
            _ => g().mid,
        };
        let sty = if who == "you" { Sty::Me } else { Sty::Person };
        let mut l = TLine::row(0).s(format!("{who:<5} "), sty);
        l.push(truncate(&input, 60), Sty::Dim);
        l.push(format!("  {mark} {}", t.status), Sty::Dim);
        l
    }

    pub fn connecting(&mut self) {
        if self.conn != Conn::Online {
            self.conn = Conn::Connecting;
        }
    }

    pub fn offline(&mut self, retry_at: i64) {
        self.conn = Conn::Offline { retry_at };
        for o in &mut self.outgoing {
            if o.state == OutState::Sending {
                o.state = OutState::Pending;
            }
        }
    }

    pub fn online(&mut self) {
        self.conn = Conn::Online;
        for o in &mut self.outgoing {
            if o.state == OutState::Pending {
                o.state = OutState::Sending;
            }
        }
    }

    /// The log was rewritten from `from_seq`: what was printed stays, a line
    /// says so, and the live state starts over from the replacement events.
    pub fn epoch_reset(&mut self, from_seq: u64) {
        self.events.retain(|e| e.seq() < from_seq);
        self.last_seq = from_seq.saturating_sub(1);
        if let Some(t) = self.turn.take() {
            let _ = t;
        }
        self.note(&format!("{} the computer was lost: the rest of this turn was rewritten", g().rule.repeat(2)));
    }

    // ---- our messages ------------------------------------------------

    /// A message typed here: drawn at once, marked `sending` (or `pending`
    /// when offline). Returns its id, for [`Model::sent`].
    pub fn send_local(&mut self, text: &str, queue: bool) -> u64 {
        let id = self.next_out;
        self.next_out += 1;
        let state = if matches!(self.conn, Conn::Offline { .. }) { OutState::Pending } else { OutState::Sending };
        self.outgoing.push(Outgoing { id, text: text.to_string(), queue, state });
        id
    }

    /// The result of sending (`turns.send` or the create): `{turn, delivery, seq}`.
    pub fn sent(&mut self, id: u64, result: Result<&Value, &crate::error::Error>, now: i64) {
        let Some(i) = self.outgoing.iter().position(|o| o.id == id) else { return };
        match result {
            Err(e) => {
                let o = self.outgoing.remove(i);
                self.error(&format!("not sent: {}", e.message));
                self.effects.push(Effect::Restore(o.text));
            }
            Ok(v) => {
                let delivery = s(v, "delivery").unwrap_or_default();
                let turn_id = v.pointer("/turn/id").and_then(Value::as_str).unwrap_or("").to_string();
                let seq = u(v, "seq").unwrap_or(0);
                self.deliver(i, &delivery, &turn_id, seq, now);
            }
        }
    }

    /// Our message was accepted: place it by how it was delivered.
    fn deliver(&mut self, i: usize, delivery: &str, turn_id: &str, seq: u64, _now: i64) {
        if matches!(self.outgoing[i].state, OutState::Steered { .. }) {
            return;
        }
        match delivery {
            "queued" => {
                let o = self.outgoing.remove(i);
                if !turn_id.is_empty() {
                    self.echoed.insert(turn_id.to_string());
                    self.received.insert(turn_id.to_string(), (None, o.text.clone()));
                }
                if !turn_id.is_empty() && self.turn.as_ref().is_some_and(|t| t.id == turn_id) {
                    // Its turn already started.
                    self.print_message(None, &o.text, None);
                } else if !self.queued.iter().any(|q| q.turn_id == turn_id) {
                    self.queued.push(Queued { turn_id: turn_id.to_string(), text: o.text, who: None });
                }
            }
            "steered" if !turn_id.is_empty() => {
                self.outgoing[i].state = OutState::Steered { turn_id: turn_id.to_string(), seq };
                if let Some(t) = self.turn.as_mut().filter(|t| t.id == turn_id) {
                    t.steered_unread += 1;
                }
            }
            _ => {
                let o = self.outgoing.remove(i);
                if !turn_id.is_empty() {
                    self.echoed.insert(turn_id.to_string());
                    self.received.insert(turn_id.to_string(), (None, o.text.clone()));
                }
                self.print_message(None, &o.text, None);
            }
        }
    }

    /// `you   text`, or `Mo · slack` and the text under it.
    fn print_message(&mut self, who: Option<&Actor>, text: &str, mark: Option<&str>) {
        let text = clean(text);
        let mut l = match who {
            None => TLine::new(0, TEXT_INDENT).s(format!("{:<width$}", "you", width = TEXT_INDENT), Sty::Me),
            Some(a) => {
                let label = format!("{} {} {}", if a.name.is_empty() { "someone" } else { &a.name }, g().mid, via_label(a));
                self.out.push(TLine::row(0).s(label, Sty::Person));
                TLine::new(TEXT_INDENT, TEXT_INDENT)
            }
        };
        let mut lines = text.split('\n');
        l.push(lines.next().unwrap_or(""), Sty::Plain);
        if let Some(m) = mark {
            l.push(format!("  {m}"), Sty::Dim);
        }
        self.out.push(l);
        for rest in lines {
            self.out.push(TLine::new(TEXT_INDENT, TEXT_INDENT).s(rest, Sty::Plain));
        }
    }

    /// The last message we queued, taken back for editing (`↑`).
    pub fn take_last_queued(&mut self) -> Option<Queued> {
        let i = self.queued.iter().rposition(|q| q.who.is_none())?;
        Some(self.queued.remove(i))
    }

    /// Messages not sent because the connection is down, taken back (`Esc`).
    pub fn take_pending(&mut self) -> Vec<Outgoing> {
        let (p, keep): (Vec<_>, Vec<_>) = self.outgoing.drain(..).partition(|o| o.state == OutState::Pending);
        self.outgoing = keep;
        p
    }

    // ---- recorded events ----------------------------------------------

    pub fn event(&mut self, ev: &Event, now: i64) {
        if ev.seq() != 0 && ev.seq() <= self.last_seq && !self.events.is_empty() {
            return; // already applied
        }
        if !ev.session_id().is_empty() && ev.session_id() != self.session_id {
            return;
        }
        self.last_seq = self.last_seq.max(ev.seq());
        self.events.push(ev.clone());
        let replay = self.is_replay(ev);
        let at = self.stamp(ev, now);
        let d = ev.data().clone();
        let tid = ev.turn_id().unwrap_or("").to_string();
        if let Some(t) = self.turn.as_mut()
            && t.id == tid
        {
            t.activity = at;
            t.activity_paused0 = self.paused_total + self.paused_since.map(|s| (at - s).max(0)).unwrap_or(0);
        }
        match ev.kind() {
            "session.created" => {
                if let Some(t) = s(&d, "title") {
                    self.title = t;
                }
                if let Some(st) = d.get("settings").and_then(|v| serde_json::from_value::<Settings>(v.clone()).ok()) {
                    self.settings = st;
                }
            }
            "session.status_changed" => {
                if let Some(to) = s(&d, "to") {
                    self.status = to;
                }
            }
            "session.updated" => self.session_updated(&d),
            "session.compacted" => {
                self.compacting = false;
                let (b, a) = (u(&d, "beforeTokens"), u(&d, "afterTokens"));
                let mut text = format!("{} conversation compacted", g().rule.repeat(2));
                if let (Some(b), Some(a)) = (b, a) {
                    text.push_str(&format!(" {} {} {} {}", g().mid, tokens(b), g().arrow, tokens(a)));
                    if let Some((_, w)) = self.context {
                        self.context = Some((a, w));
                    }
                }
                self.note(&text);
            }
            "runtime.starting" => {
                let phase = s(&d, "phase").unwrap_or_default();
                self.runtime = Some(match phase.as_str() {
                    "computer" => "starting your computer".into(),
                    _ if self.status == "suspended" => "resuming".into(),
                    _ => "starting".into(),
                });
            }
            "runtime.connected" => {
                self.runtime = None;
                if !replay {
                    let warm = d.get("warm").and_then(Value::as_bool).unwrap_or(false);
                    let fact = if warm {
                        "warm start".to_string()
                    } else {
                        match u(&d, "durationMs") {
                            Some(ms) => format!("cold start {} {}", g().mid, dur(ms)),
                            None => "cold start".into(),
                        }
                    };
                    self.set_fact(fact, now);
                }
            }
            "runtime.suspended" => {
                self.status = "suspended".into();
                self.runtime = None;
            }
            "usage.recorded" => {
                if let (Some(a), Some(b)) = (u(&d, "usedTokens"), u(&d, "windowTokens")) {
                    self.context = Some((a, b));
                }
            }
            "model.rate_limited" => {
                if !replay {
                    self.rate_limited_until = Some(now + u(&d, "retryAfterMs").unwrap_or(0) as i64);
                }
            }
            "message.received" => self.message_received(ev, &d, &tid, now),
            "turn.queued" => {
                if !self.queued.iter().any(|q| q.turn_id == tid)
                    && let Some((who, text)) = self.received.get(&tid).cloned()
                {
                    // Ours is already queued from the send's result, or
                    // still in flight and placed when it returns.
                    let ours = who.is_none() && self.outgoing.iter().any(|o| o.text == text);
                    if !ours {
                        self.queued.push(Queued { turn_id: tid.clone(), text, who });
                    }
                }
            }
            "turn.steered" => self.steered(&tid, ev.seq()),
            "turn.started" => self.turn_started(ev, &d, &tid, at, replay),
            "message.completed" => {
                if d.get("parentCallId").is_some_and(|p| !p.is_null()) {
                    return;
                }
                let block = s(&d, "blockId").unwrap_or_default();
                let text = d.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                self.text_block(&tid, &block, at);
                if let Some(t) = self.turn.as_mut()
                    && let Some((_, md)) = t.text.as_mut()
                {
                    md.complete_with(&text);
                    let lines = md.take();
                    self.last_text = Some(md.source.clone());
                    if md.last_code.is_some() {
                        self.last_code = md.last_code.clone();
                    }
                    t.text = None;
                    self.out.extend(lines);
                }
            }
            "reasoning.completed" => {
                let block = s(&d, "blockId").unwrap_or_default();
                let ms = u(&d, "durationMs");
                let text = d.get("text").and_then(Value::as_str).unwrap_or("").to_string();
                self.ensure_turn(&tid, at, replay);
                let show = self.show_reasoning;
                if let Some(t) = self.turn.as_mut() {
                    let first = !t.any;
                    t.any = true;
                    let started = t.reasoning.as_ref().filter(|r| r.block == block).map(|r| r.start);
                    t.reasoning = None;
                    let ms = ms.unwrap_or_else(|| started.map(|s| (at - s).max(0) as u64).unwrap_or(0));
                    if ms >= THOUGHT_MIN_MS || first {
                        t.run.thought_ms += ms;
                    }
                }
                if show && !text.trim().is_empty() {
                    for line in clean(&text).lines() {
                        self.out.push(TLine::new(TEXT_INDENT, TEXT_INDENT).s(line, Sty::Dim));
                    }
                }
            }
            "tool.started" => self.tool_started(&d, &tid, at, replay),
            "tool.completed" | "tool.failed" => self.tool_ended(ev.kind() == "tool.failed", &d, at),
            "turn.completed" | "turn.failed" | "turn.cancelled" => self.turn_ended(ev, &d, &tid, at, now, replay),
            "turn.status_changed" => {}
            "ask.opened" => {
                if let Some(ask) = d.get("ask").and_then(|a| serde_json::from_value::<Ask>(a.clone()).ok()) {
                    let what = ask.describe();
                    self.asks.retain(|a| a.id != ask.id);
                    if ask.is_open() {
                        self.asks.push(ask);
                    }
                    self.update_pause(at);
                    self.notify(replay, format!("needs you: {what}"));
                }
            }
            "ask.closed" => {
                if let Some(ask) = d.get("ask").and_then(|a| serde_json::from_value::<Ask>(a.clone()).ok()) {
                    self.asks.retain(|a| a.id != ask.id);
                    self.update_pause(at);
                    let l = self.ask_closed_line(&ask, ev.actor().as_ref());
                    self.out.push(l);
                }
            }
            "subagent.started" => {
                if let Some(sa) = d.get("subagent").and_then(|a| serde_json::from_value::<Subagent>(a.clone()).ok()) {
                    self.subagent_started(sa, &tid, at, replay);
                }
            }
            "subagent.ended" => {
                if let Some(sa) = d.get("subagent").and_then(|a| serde_json::from_value::<Subagent>(a.clone()).ok()) {
                    self.subagent_ended(sa, at, replay);
                }
            }
            "files.pushed" => {
                let path = s(&d, "path").unwrap_or_default();
                let files = u(&d, "files").unwrap_or(0);
                self.note(&format!("{} pushed {} {} {}", g().up, path, g().mid, plural(files as usize, "file")));
            }
            _ => {}
        }
    }

    fn session_updated(&mut self, d: &Value) {
        let Some(changes) = d.get("changes").and_then(Value::as_object) else { return };
        let mut settings_changed = false;
        for (field, ch) in changes {
            let to = ch.get("to");
            let to_s = to.and_then(Value::as_str).map(clean);
            match field.as_str() {
                "title" => {
                    if let Some(t) = to_s {
                        self.title = t;
                    }
                }
                "model" | "effort" | "speed" | "mode" => {
                    let from = ch.get("from").and_then(Value::as_str).unwrap_or("").to_string();
                    let label = |v: &str| {
                        match field.as_str() {
                            "mode" => mode_label(v).unwrap_or_else(|| "usual permissions".into()),
                            // Not set means the default, fast.
                            "speed" if v.is_empty() => "fast".into(),
                            _ => v.to_string(),
                        }
                    };
                    let before = if field == "model" { self.model_name() } else { label(&from) };
                    match field.as_str() {
                        "model" => self.settings.model = to_s.clone(),
                        "effort" => self.settings.effort = to_s.clone(),
                        "speed" => self.settings.speed = to_s.clone(),
                        _ => self.settings.mode = to_s.clone(),
                    }
                    let after = if field == "model" { self.model_name() } else { label(to_s.as_deref().unwrap_or_default()) };
                    let when = if self.turn.is_some() && field != "mode" { ", from the next turn" } else { "" };
                    self.note(&format!("{field}: {before} {} {after}{when}", g().arrow));
                    settings_changed = true;
                }
                _ => {}
            }
        }
        let _ = settings_changed;
        self.maybe_header();
    }

    /// Which of our in-flight messages an echo is, if any.
    fn our_outgoing(&self, actor: Option<&Actor>, input: &str) -> Option<usize> {
        let ours = match (actor, &self.me) {
            (Some(a), Some(me)) => &a.id == me,
            (Some(a), None) => via_label(a) == "opc",
            (None, _) => true,
        };
        if !ours {
            return None;
        }
        self.outgoing.iter().position(|o| o.text == input && !matches!(o.state, OutState::Steered { .. }))
    }

    fn message_received(&mut self, ev: &Event, d: &Value, tid: &str, now: i64) {
        let input = d.get("input").and_then(Value::as_str).unwrap_or("").to_string();
        let delivery = s(d, "delivery").unwrap_or_default();
        let actor = ev.actor();
        if let Some(ids) = d.get("declinedAskIds").and_then(Value::as_array) {
            for id in ids.iter().filter_map(Value::as_str) {
                self.declined_by.insert(id.to_string(), first_line(&clean(&input)).to_string());
            }
        }
        if delivery != "steered" && self.echoed.remove(tid) {
            return;
        }
        if let Some(i) = self.our_outgoing(actor.as_ref(), &input) {
            self.received.insert(tid.to_string(), (None, input));
            self.deliver(i, &delivery, tid, ev.seq(), now);
            return;
        }
        let mine = match (&actor, &self.me) {
            (Some(a), Some(me)) => &a.id == me,
            (None, _) => true,
            _ => false,
        };
        let who = if mine { None } else { actor.clone() };
        self.received.insert(tid.to_string(), (who.as_ref().map(|a| a.name.clone()), input.clone()));
        match delivery.as_str() {
            "queued" => {
                // Shown as a queued line by `turn.queued`, and printed when
                // its turn starts.
            }
            "steered" => {
                if let Some(t) = self.turn.as_mut().filter(|t| t.id == tid) {
                    t.steered_unread += 1;
                }
                self.print_message(who.as_ref(), &input, Some(g().steer));
            }
            _ => self.print_message(who.as_ref(), &input, None),
        }
    }

    fn steered(&mut self, tid: &str, _seq: u64) {
        if let Some(t) = self.turn.as_mut().filter(|t| t.id == tid) {
            t.steered_unread = t.steered_unread.saturating_sub(1);
        }
        if let Some(i) = self.outgoing.iter().position(|o| matches!(&o.state, OutState::Steered { turn_id, .. } if turn_id == tid)) {
            let o = self.outgoing.remove(i);
            let read = format!("{} read", g().steer);
            self.print_message(None, &o.text, Some(&read));
        }
    }

    fn ensure_turn(&mut self, tid: &str, at: i64, replay: bool) {
        if tid.is_empty() {
            return;
        }
        if self.turn.as_ref().is_some_and(|t| t.id == tid) {
            return;
        }
        if self.turn.is_some() {
            // A turn whose end we missed.
            self.settle_turn(None, at);
        }
        let p = self.paused(at);
        self.turn = Some(TurnLive {
            id: tid.to_string(),
            start: at,
            paused0: p,
            activity: at,
            activity_paused0: p,
            any: false,
            replay,
            text: None,
            reasoning: None,
            run: Run::default(),
            steps: 0,
            files: BTreeMap::new(),
            steered_unread: 0,
        });
    }

    fn turn_started(&mut self, ev: &Event, d: &Value, tid: &str, at: i64, replay: bool) {
        // A queued message whose turn starts now: it moves to the transcript.
        if let Some(i) = self.queued.iter().position(|q| q.turn_id == tid) {
            let q = self.queued.remove(i);
            match &q.who {
                None => self.print_message(None, &q.text, None),
                Some(name) => {
                    let a = Actor { name: name.clone(), ..Default::default() };
                    self.print_message(Some(&a), &q.text, None);
                }
            }
        } else if let Some(sa) = s(d, "subagentId") {
            self.self_started(Some(&sa));
        } else if !self.received.contains_key(tid) {
            if self.carried_over > 0 {
                self.carried_over -= 1;
            } else if self.turns_seen > 0 {
                self.self_started(None);
            }
        }
        let _ = ev;
        self.turns_seen += 1;
        self.status = "running".into();
        self.ensure_turn(tid, at, replay);
    }

    /// A turn the agent started itself: a dim header, never an empty `you`.
    fn self_started(&mut self, subagent: Option<&str>) {
        let mut text = "agent".to_string();
        if let Some(id) = subagent {
            match self.subs.iter().find(|x| x.sa.id == id) {
                Some(sub) => text.push_str(&format!(" {} background subagent \"{}\" finished", g().steer, sub.sa.name)),
                None => text.push_str(&format!(" {} a background subagent finished", g().steer)),
            }
        }
        self.out.push(TLine::row(0).s(text, Sty::Dim));
    }

    /// A text block starts or continues: the run before it settles.
    fn text_block(&mut self, tid: &str, block: &str, at: i64) {
        let replay = self.turn.as_ref().map(|t| t.replay).unwrap_or(true);
        self.ensure_turn(tid, at, replay);
        let Some(t) = self.turn.as_mut() else { return };
        t.any = true;
        if t.text.as_ref().is_some_and(|(b, _)| b == block) {
            return;
        }
        // A new block: finish the previous one, settle the run.
        if let Some((_, mut md)) = t.text.take() {
            md.finish();
            let lines = md.take();
            self.last_text = Some(md.source.clone());
            self.out.extend(lines);
        }
        self.settle_run(false);
        if let Some(t) = self.turn.as_mut() {
            t.text = Some((block.to_string(), Md::new(REPLY_INDENT)));
        }
    }

    fn tool_started(&mut self, d: &Value, tid: &str, at: i64, replay: bool) {
        let tool = s(d, "toolName").unwrap_or_default();
        let call = s(d, "callId").unwrap_or_default();
        // Inside a subagent: nested in details, counted by its progress.
        if d.get("subagentId").is_some_and(|v| !v.is_null()) || d.get("parentCallId").is_some_and(|v| !v.is_null()) {
            return;
        }
        if is_todo_tool(&tool) {
            if let Some(list) = d.pointer("/input/todos").and_then(Value::as_array) {
                self.todos_updated(list);
            }
            return;
        }
        self.ensure_turn(tid, at, replay);
        let title = step_title(&tool, d);
        let p = self.paused(at);
        // A text block in progress ends where the steps begin.
        if let Some(t) = self.turn.as_mut() {
            t.any = true;
            if let Some((_, mut md)) = t.text.take() {
                md.finish();
                self.last_text = Some(md.source.clone());
                let lines = md.take();
                self.out.extend(lines);
            }
        }
        let Some(t) = self.turn.as_mut() else { return };
        if let Some(st) = t.run.steps.iter_mut().find(|x| x.call_id == call && !call.is_empty()) {
            st.state = StepState::Running;
            st.title = title;
            st.tool = tool;
            st.lines = None;
            return;
        }
        let sub = self.subs.iter().find(|x| x.sa.call_id.as_deref() == Some(call.as_str()) && !call.is_empty()).map(|x| x.sa.id.clone());
        t.run.steps.push(Step {
            call_id: call,
            tool,
            title,
            state: StepState::Running,
            start: at,
            paused0: p,
            end: None,
            dur_ms: None,
            added: 0,
            removed: 0,
            lines: None,
            subagent: sub,
            output: Vec::new(),
        });
    }

    fn tool_ended(&mut self, failed: bool, d: &Value, at: i64) {
        let call = s(d, "callId").unwrap_or_default();
        let settled_by = s(d, "settledBy");
        let changes: Vec<(String, u64, u64)> = d
            .get("fileChanges")
            .and_then(Value::as_array)
            .map(|a| a.iter().map(|c| (s(c, "path").unwrap_or_default(), u(c, "added").unwrap_or(0), u(c, "removed").unwrap_or(0))).collect())
            .unwrap_or_default();
        let Some(t) = self.turn.as_mut() else { return };
        for (p, a, r) in &changes {
            let e = t.files.entry(p.clone()).or_insert((0, 0));
            e.0 += a;
            e.1 += r;
        }
        let Some(st) = t.run.steps.iter_mut().find(|x| x.call_id == call) else { return };
        st.state = match (failed, settled_by.is_some()) {
            (false, _) => StepState::Ok,
            (true, true) => StepState::Cut,
            (true, false) => StepState::Failed,
        };
        st.end = Some(at);
        st.dur_ms = u(d, "durationMs").or(Some((at - st.start).max(0) as u64));
        st.added = changes.iter().map(|c| c.1).sum();
        st.removed = changes.iter().map(|c| c.2).sum();
    }

    fn todos_updated(&mut self, list: &[Value]) {
        let todos: Vec<Todo> = list
            .iter()
            .map(|v| Todo { content: s(v, "content").unwrap_or_default(), status: s(v, "status").unwrap_or_default(), active: s(v, "activeForm") })
            .filter(|t| !t.content.is_empty())
            .collect();
        for t in &todos {
            if t.status == "completed" && self.todo_printed.insert(t.content.clone()) {
                self.out.push(TLine::new(2, 4).s(format!("{} ", g().ok), Sty::Ok).s(t.content.clone(), Sty::Dim));
            }
        }
        self.todos = if todos.iter().all(|t| t.status == "completed") { Vec::new() } else { todos };
    }

    fn turn_ended(&mut self, ev: &Event, d: &Value, tid: &str, at: i64, now: i64, replay: bool) {
        let kind = ev.kind();
        // A queued turn cancelled before it ran.
        if let Some(i) = self.queued.iter().position(|q| q.turn_id == tid) {
            let q = self.queued.remove(i);
            if q.who.is_none() && !replay && self.interrupted_at.is_some() {
                self.effects.push(Effect::Restore(q.text));
            } else {
                self.note(&format!("{} cancelled: {}", g().fail, truncate(first_line(&q.text), 60)));
            }
            return;
        }
        if self.turn.as_ref().is_none_or(|t| t.id != tid) {
            if kind == "turn.cancelled" && !replay {
                // Withdrawn before we saw it start.
                if let Some(input) = s(d, "input")
                    && self.interrupted_at.is_some()
                    && self.received.get(tid).is_some_and(|(w, _)| w.is_none())
                {
                    self.effects.push(Effect::Restore(input));
                }
            }
            return;
        }
        // Our steered messages the agent never read run as the next turn.
        let mut carried = 0;
        let mut i = 0;
        while i < self.outgoing.len() {
            if matches!(&self.outgoing[i].state, OutState::Steered { turn_id, .. } if turn_id == tid) {
                let o = self.outgoing.remove(i);
                self.print_message(None, &o.text, None);
                carried += 1;
            } else {
                i += 1;
            }
        }
        if let Some(t) = &self.turn {
            carried = carried.max(t.steered_unread);
        }
        self.carried_over += carried;
        let started = self.turn.as_ref().map(|t| (t.start, t.paused0)).unwrap_or((at, 0));
        let long = (at - started.0) > NOTIFY_AFTER_MS;
        let text = d.get("text").and_then(Value::as_str).map(str::to_string);
        let silent = d.get("silent").and_then(Value::as_bool).unwrap_or(false);
        let ending = Ending {
            kind: kind.to_string(),
            text,
            silent,
            dur_ms: u(d, "durationMs"),
            reason: s(d, "reason"),
            error: d.get("error").and_then(|e| s(e, "message").or_else(|| s(e, "code"))),
        };
        self.settle_turn(Some(ending), at);
        self.status = if self.queued.is_empty() { "idle".into() } else { "running".into() };
        if !replay && long {
            let what = match kind {
                "turn.completed" => "finished",
                "turn.failed" => "failed",
                _ => "stopped",
            };
            let t = if self.title.is_empty() { "the turn".to_string() } else { format!("\"{}\"", self.title) };
            self.notify(false, format!("{t} {what}"));
        }
        if kind == "turn.cancelled" && self.interrupted_at.is_some() && !replay {
            self.interrupted_at = Some(now + INTERRUPT_SETTLE_MS);
        }
    }

    /// We asked to interrupt: when the turn settles, say whether background
    /// subagents survived it.
    pub fn interrupting(&mut self, now: i64) {
        self.interrupted_at = Some(now + 60_000);
    }

    /// Time passes: facts fade, the interrupt check runs.
    pub fn tick(&mut self, now: i64) {
        if let Some((_, until)) = &self.fact
            && *until <= now
        {
            self.fact = None;
        }
        if let Some(t) = self.rate_limited_until
            && t <= now
        {
            self.rate_limited_until = None;
        }
        if let Some(at) = self.interrupted_at
            && at <= now
        {
            self.interrupted_at = None;
            let bg = self.subs.iter().filter(|x| x.sa.is_running() && x.sa.background).count();
            if bg > 0 && self.turn.is_none() {
                let text = format!("interrupted {} {} still running {} /subagents", g().mid, plural(bg, "background subagent"), g().mid);
                self.set_fact_for(text, now + 15_000);
            }
        }
    }

    // ---- settling -----------------------------------------------------

    fn settle_turn(&mut self, ending: Option<Ending>, at: i64) {
        let Some(mut t) = self.turn.take() else { return };
        if let Some((_, mut md)) = t.text.take() {
            md.finish();
            self.last_text = Some(md.source.clone());
            if md.last_code.is_some() {
                self.last_code = md.last_code.clone();
            }
            let lines = md.take();
            self.out.extend(lines);
        }
        let cut = ending.as_ref().is_some_and(|e| e.kind != "turn.completed");
        if cut {
            for st in &mut t.run.steps {
                if matches!(st.state, StepState::Running) {
                    st.state = StepState::Cut;
                    st.end = Some(at);
                }
            }
        }
        t.run.steps.retain(|st| st.state != StepState::Preparing);
        t.steps += t.run.steps.len();
        let run = std::mem::take(&mut t.run);
        let lines = self.run_lines(&run);
        self.out.extend(lines);
        let Some(e) = ending else { return };
        self.todos.clear();
        let wrote = self.out.iter().any(|_| true);
        let _ = wrote;
        match e.kind.as_str() {
            "turn.completed" => {
                if e.silent {
                    self.out.push(TLine::new(REPLY_INDENT, REPLY_INDENT).s("(no reply)", Sty::Dim));
                } else if self.turn_had_no_text(&t)
                    && let Some(text) = e.text.filter(|x| !x.trim().is_empty())
                {
                    let mut md = Md::new(REPLY_INDENT);
                    md.push(&text);
                    md.finish();
                    self.last_text = Some(md.source.clone());
                    self.out.extend(md.take());
                }
            }
            "turn.failed" => {
                let msg = e.error.unwrap_or_else(|| "the turn failed".into());
                self.error(&format!("failed: {msg}"));
            }
            _ => {}
        }
        let total = e.dur_ms.unwrap_or_else(|| (at - t.start).max(0) as u64);
        let mut parts = Vec::new();
        match e.kind.as_str() {
            "turn.cancelled" => {
                let r = e.reason.unwrap_or_else(|| "cancelled".into());
                parts.push(r);
            }
            "turn.failed" => parts.push("failed".into()),
            _ => {}
        }
        parts.push(dur(total));
        if t.steps > 0 {
            parts.push(plural(t.steps, "step"));
        }
        if !t.files.is_empty() {
            let a: u64 = t.files.values().map(|x| x.0).sum();
            let r: u64 = t.files.values().map(|x| x.1).sum();
            parts.push(format!("{} changed, {}", plural(t.files.len(), "file"), change(a, r)));
        }
        let mid = format!(" {} ", g().mid);
        self.out.push(TLine::row(2).s(format!("{} {}", g().rule.repeat(2), parts.join(&mid)), Sty::Dim));
    }

    fn turn_had_no_text(&self, t: &TurnLive) -> bool {
        // Text was printed for this turn if a block was ever opened.
        !t.any || self.last_text.is_none()
    }

    /// The agent wrote again: the run of steps before it becomes one line.
    fn settle_run(&mut self, _final: bool) {
        let Some(t) = self.turn.as_mut() else { return };
        if t.run.steps.iter().any(|s| matches!(s.state, StepState::Running)) {
            // Text written while a step runs (parallel calls): keep the run.
            return;
        }
        t.run.steps.retain(|st| st.state != StepState::Preparing);
        t.steps += t.run.steps.len();
        let run = std::mem::take(&mut t.run);
        let lines = self.run_lines(&run);
        self.out.extend(lines);
    }

    /// One line for a settled run.
    fn run_lines(&self, run: &Run) -> Vec<TLine> {
        let mid = format!(" {} ", g().mid);
        let thought = (run.thought_ms > 0).then(|| format!("thought {}", dur(run.thought_ms)));
        if run.steps.is_empty() {
            return match thought {
                Some(th) => vec![TLine::row(2).s(th, Sty::Dim)],
                None => vec![],
            };
        }
        let cut = run.steps.iter().any(|s| s.state == StepState::Cut);
        let failed = run.steps.iter().filter(|s| s.state == StepState::Failed).count();
        let mark = |l: TLine| if cut { l.s(format!("{} ", g().fail), Sty::Err) } else { l.s(format!("{} ", g().ok), Sty::Ok) };
        let mut l = mark(TLine::row(2));
        if run.steps.len() == 1 {
            let st = &run.steps[0];
            if let Some(id) = &st.subagent
                && let Some(sub) = self.subs.iter().find(|x| &x.sa.id == id)
                && !sub.sa.background
            {
                l.segs.extend(self.subagent_segs(sub, i64::MAX, true));
            } else {
                l.push(tool_name(&st.tool), Sty::Bold);
                if !st.title.is_empty() {
                    l.push(format!("  {}", st.title), Sty::Plain);
                }
                if st.added + st.removed > 0 {
                    l.push(format!("  {}", change(st.added, st.removed)), Sty::Dim);
                } else if let Some(ms) = st.dur_ms.filter(|ms| *ms >= 1000) {
                    l.push(format!("{mid}{}", dur(ms)), Sty::Dim);
                }
                if st.state == StepState::Failed {
                    l.push(format!("{mid}failed"), Sty::Warn);
                }
            }
        } else {
            let mut names: Vec<(String, usize)> = Vec::new();
            for st in &run.steps {
                let n = tool_name(&st.tool);
                match names.iter_mut().find(|(x, _)| *x == n) {
                    Some(e) => e.1 += 1,
                    None => names.push((n, 1)),
                }
            }
            let list = names.iter().map(|(n, c)| if *c > 1 { format!("{n} {}{c}", g().times) } else { n.clone() }).collect::<Vec<_>>().join(", ");
            l.push(format!("Ran {} steps", run.steps.len()), Sty::Bold);
            l.push(format!("{mid}{list}"), Sty::Plain);
            let start = run.steps.iter().map(|s| s.start).min().unwrap_or(0);
            let end = run.steps.iter().map(|s| s.end.unwrap_or(s.start + s.dur_ms.unwrap_or(0) as i64)).max().unwrap_or(start);
            let ms = (end - start).max(0) as u64;
            if ms >= 1000 {
                l.push(format!("{mid}{}", dur(ms)), Sty::Dim);
            }
            let (a, r) = run.steps.iter().fold((0, 0), |acc, s| (acc.0 + s.added, acc.1 + s.removed));
            if a + r > 0 {
                l.push(format!("{mid}{}", change(a, r)), Sty::Dim);
            }
            if failed > 0 {
                l.push(format!("{mid}{failed} failed"), Sty::Warn);
            }
        }
        if let Some(th) = thought {
            l.push(format!("{mid}{th}"), Sty::Dim);
        }
        vec![l]
    }

    // ---- asks -----------------------------------------------------------

    fn ask_closed_line(&self, ask: &Ask, actor: Option<&Actor>) -> TLine {
        let by = match actor.or(ask.closed_by.as_ref()) {
            Some(a) if Some(&a.id) != self.me.as_ref() && !a.name.is_empty() => {
                let via = via_phrase(a);
                if via.is_empty() { format!(" by {}", a.name) } else { format!(" by {} {via}", a.name) }
            }
            _ => String::new(),
        };
        let mid = format!(" {} ", g().mid);
        let ans = ask.answer.clone().unwrap_or(Value::Null);
        let title = match ask.kind.as_str() {
            "approval" => ask.approval.as_ref().map(|a| a.title.clone()).unwrap_or_default(),
            _ => String::new(),
        };
        let (ok, text) = match ask.status.as_str() {
            "answered" | "closed" => match ask.kind.as_str() {
                "approval" => match ans.get("decision").and_then(Value::as_str).unwrap_or("") {
                    "deny" => (false, format!("denied{by}{mid}{title}")),
                    "always" => {
                        let rule = ask.approval.as_ref().and_then(|a| a.always_allows.clone()).unwrap_or(title.clone());
                        (true, format!("allowed for this session{by}: {rule}"))
                    }
                    _ => (true, format!("allowed{by}{mid}{title}")),
                },
                "question" => {
                    let picks: Vec<String> = ans
                        .get("answers")
                        .and_then(Value::as_array)
                        .map(|a| {
                            a.iter()
                                .flat_map(|x| {
                                    let mut v: Vec<String> = x.get("choices").and_then(Value::as_array).map(|c| c.iter().filter_map(|y| y.as_str().map(str::to_string)).collect()).unwrap_or_default();
                                    if let Some(t) = x.get("text").and_then(Value::as_str) {
                                        v.push(t.to_string());
                                    }
                                    v
                                })
                                .collect()
                        })
                        .unwrap_or_default();
                    (true, format!("answered{by}{mid}{}", picks.join(", ")))
                }
                "secret" => {
                    let name = ask.secret.as_ref().map(|s| s.name.clone()).unwrap_or_default();
                    let scope = ans.get("scope").and_then(Value::as_str).unwrap_or("this session");
                    let scope = match scope {
                        "session" => "this session",
                        "me" => "all your sessions",
                        "organization" => "everyone",
                        x => x,
                    };
                    (true, format!("{name} set{by} for {scope}"))
                }
                _ => (true, format!("answered{by}{mid}{}", ask.describe())),
            },
            other => {
                let st = if other.is_empty() { "closed" } else { other };
                match self.declined_by.get(&ask.id).filter(|m| !m.is_empty() && st == "declined") {
                    Some(m) => (false, format!("{st}{by}{mid}{m}")),
                    None => (false, format!("{st}{by}{mid}{}", ask.describe())),
                }
            }
        };
        let (glyph, sty) = if ok { (g().ok, Sty::Ok) } else { (g().fail, Sty::Err) };
        TLine::new(2, 4).s(format!("{glyph} "), sty).s(clean(&text), Sty::Plain)
    }

    pub fn open_asks(&self) -> impl Iterator<Item = &Ask> {
        self.asks.iter().filter(|a| a.is_open())
    }

    // ---- subagents ------------------------------------------------------

    fn upsert_sub(&mut self, sa: Subagent, at: i64) {
        let start = sa.created_at.as_deref().and_then(super::parse_time).unwrap_or(at);
        match self.subs.iter_mut().find(|x| x.sa.id == sa.id) {
            Some(x) => x.sa = sa,
            None => self.subs.push(Sub { sa, start, end: None }),
        }
    }

    fn subagent_started(&mut self, sa: Subagent, tid: &str, at: i64, _replay: bool) {
        let id = sa.id.clone();
        let call = sa.call_id.clone();
        let bg = sa.background;
        self.upsert_sub(sa, at);
        if bg {
            return;
        }
        // Tie it to the step that launched it, or give it a step.
        if let Some(t) = self.turn.as_mut().filter(|t| t.id == tid || tid.is_empty()) {
            if let Some(st) = call.as_deref().and_then(|c| t.run.steps.iter_mut().find(|x| x.call_id == c)) {
                st.subagent = Some(id);
            } else {
                let p = self.paused_total;
                t.run.steps.push(Step {
                    call_id: format!("subagent:{id}"),
                    tool: "Task".into(),
                    title: String::new(),
                    state: StepState::Running,
                    start: at,
                    paused0: p,
                    end: None,
                    dur_ms: None,
                    added: 0,
                    removed: 0,
                    lines: None,
                    subagent: Some(id),
                    output: Vec::new(),
                });
            }
        }
    }

    fn subagent_ended(&mut self, sa: Subagent, at: i64, replay: bool) {
        let id = sa.id.clone();
        let bg = sa.background;
        let name = sa.name.clone();
        let status = sa.status.clone();
        self.upsert_sub(sa, at);
        let mut elapsed = 0;
        if let Some(x) = self.subs.iter_mut().find(|x| x.sa.id == id) {
            x.end = Some(at);
            elapsed = x.elapsed(at);
        }
        // Its own step, if it had no launching call.
        if let Some(t) = self.turn.as_mut()
            && let Some(st) = t.run.steps.iter_mut().find(|x| x.call_id == format!("subagent:{id}"))
        {
            st.state = if status == "completed" { StepState::Ok } else { StepState::Failed };
            st.end = Some(at);
            st.dur_ms = Some(elapsed);
        }
        if bg {
            let (glyph, sty, verb) = match status.as_str() {
                "completed" => (g().ok, Sty::Ok, "finished"),
                "stopped" => (g().fail, Sty::Warn, "stopped"),
                _ => (g().fail, Sty::Err, "failed"),
            };
            let mid = g().mid;
            self.out.push(TLine::row(2).s(format!("{glyph} "), sty).s(format!("background subagent \"{name}\" {verb} {mid} {} {mid} /subagents to read", timer(elapsed)), Sty::Plain));
            self.notify(replay, format!("background subagent \"{name}\" {verb}"));
        }
    }

    pub fn running_subagents(&self) -> usize {
        self.subs.iter().filter(|x| x.sa.is_running()).count()
    }

    /// `Explore · auth flow · reading src/auth/session.ts · 14 tools · 1m 12s`
    pub fn subagent_segs(&self, sub: &Sub, now: i64, folded: bool) -> Vec<Seg> {
        let mid = format!(" {} ", g().mid);
        let mut v = Vec::new();
        if let Some(t) = sub.sa.agent_type.as_deref().filter(|t| !t.is_empty()) {
            v.push(Seg::new(t.to_string(), Sty::Bold));
            v.push(Seg::new(mid.clone(), Sty::Dim));
        }
        v.push(Seg::new(clean(&sub.sa.name), Sty::Plain));
        if !folded && let Some(a) = sub.sa.activity.as_deref().filter(|a| !a.is_empty()) {
            v.push(Seg::new(format!("{mid}{}", clean(a)), Sty::Dim));
        }
        v.push(Seg::new(format!("{mid}{}", plural(sub.sa.tool_calls as usize, "tool")), Sty::Dim));
        let e = if folded { sub.elapsed(sub.end.unwrap_or(now)) } else { sub.elapsed(now) };
        v.push(Seg::new(format!("{mid}{}", timer(e)), Sty::Dim));
        if folded && sub.sa.status != "completed" && !sub.sa.status.is_empty() {
            v.push(Seg::new(format!("{mid}{}", sub.sa.status), Sty::Warn));
        }
        v
    }

    // ---- deltas -----------------------------------------------------------

    pub fn delta(&mut self, dl: &Delta, now: i64) {
        if !dl.session_id().is_empty() && dl.session_id() != self.session_id {
            return;
        }
        let d = dl.data().clone();
        let tid = dl.turn_id().unwrap_or("").to_string();
        match dl.kind() {
            "message.delta" => {
                if d.get("parentCallId").is_some_and(|p| !p.is_null()) {
                    return;
                }
                let block = s(&d, "blockId").unwrap_or_default();
                if self.turn.as_ref().is_none_or(|t| t.id != tid) && !tid.is_empty() {
                    self.ensure_turn(&tid, now, false);
                }
                // A delta for a block already completed is stale.
                if self.events.iter().rev().take(200).any(|e| e.kind() == "message.completed" && e.str("blockId") == Some(block.as_str())) {
                    return;
                }
                self.text_block(&tid, &block, now);
                if let Some(t) = self.turn.as_mut()
                    && let Some((_, md)) = t.text.as_mut()
                {
                    md.push(dl.text());
                    let lines = md.take();
                    self.out.extend(lines);
                }
            }
            "reasoning.delta" => {
                let block = s(&d, "blockId").unwrap_or_default();
                self.ensure_turn(&tid, now, false);
                let p = self.paused(now);
                if let Some(t) = self.turn.as_mut() {
                    t.any = true;
                    match t.reasoning.as_mut() {
                        Some(r) if r.block == block => r.text.push_str(dl.text()),
                        _ => t.reasoning = Some(Reasoning { block, start: now, paused0: p, text: dl.text().to_string() }),
                    }
                }
            }
            "tool.delta" => {
                let call = s(&d, "callId").unwrap_or_default();
                if let Some(t) = self.turn.as_mut()
                    && let Some(st) = t.run.steps.iter_mut().find(|x| x.call_id == call && x.state == StepState::Running)
                {
                    let text = clean(dl.text());
                    let mut lines: Vec<String> = st.output.clone();
                    let mut first = true;
                    for part in text.split('\n') {
                        if first && !lines.is_empty() {
                            if let Some(last) = lines.last_mut() {
                                last.push_str(part);
                            }
                        } else {
                            lines.push(part.to_string());
                        }
                        first = false;
                    }
                    let n = lines.len();
                    st.output = lines.into_iter().skip(n.saturating_sub(4)).collect();
                }
            }
            "tool.preparing" => {
                if d.get("subagentId").is_some_and(|v| !v.is_null()) {
                    return;
                }
                let call = s(&d, "callId").unwrap_or_default();
                let tool = s(&d, "toolName").or_else(|| s(&d, "name")).unwrap_or_default();
                if is_todo_tool(&tool) {
                    return;
                }
                self.ensure_turn(&tid, now, false);
                let title = s(&d, "path").or_else(|| s(&d, "description")).map(|x| first_line(&x).to_string()).unwrap_or_default();
                let lines = u(&d, "lines");
                let p = self.paused(now);
                if let Some(t) = self.turn.as_mut() {
                    t.any = true;
                    if let Some((_, mut md)) = t.text.take() {
                        md.finish();
                        self.last_text = Some(md.source.clone());
                        let l = md.take();
                        self.out.extend(l);
                    }
                }
                if let Some(t) = self.turn.as_mut() {
                    match t.run.steps.iter_mut().find(|x| x.call_id == call) {
                        Some(st) if st.state == StepState::Preparing => {
                            if !title.is_empty() {
                                st.title = title;
                            }
                            st.lines = lines.or(st.lines);
                        }
                        Some(_) => {}
                        None => t.run.steps.push(Step {
                            call_id: call,
                            tool,
                            title,
                            state: StepState::Preparing,
                            start: now,
                            paused0: p,
                            end: None,
                            dur_ms: None,
                            added: 0,
                            removed: 0,
                            lines,
                            subagent: None,
                            output: Vec::new(),
                        }),
                    }
                }
            }
            "subagent.progress" => {
                let id = s(&d, "subagentId").unwrap_or_default();
                if let Some(x) = self.subs.iter_mut().find(|x| x.sa.id == id) {
                    x.sa.apply_progress(&d);
                }
            }
            "session.compacting" => self.compacting = true,
            _ => {}
        }
    }

    // ---- the live area ------------------------------------------------------

    pub fn turn_running(&self) -> bool {
        self.turn.is_some()
    }

    pub fn active_turn_id(&self) -> Option<&str> {
        self.turn.as_ref().map(|t| t.id.as_str())
    }

    /// Everything above the rule that is still changing, top to bottom.
    /// `ask` is drawn by the app between the run and the pinned lines.
    pub fn live(&self, now: i64) -> (Vec<TLine>, Vec<TLine>) {
        let mut top = Vec::new();
        let mid = format!(" {} ", g().mid);
        for o in &self.outgoing {
            let mut l = TLine::new(0, TEXT_INDENT).s(format!("{:<width$}", "you", width = TEXT_INDENT), Sty::Me);
            l.push(first_line(&o.text).to_string(), Sty::Plain);
            match &o.state {
                OutState::Sending => l.push("  sending", Sty::Dim),
                OutState::Pending => l.push("  pending", Sty::Warn),
                OutState::Steered { .. } => l.push(format!("  {}", g().steer), Sty::Dim),
            }
            top.push(l);
        }
        if let Some(t) = &self.turn {
            if let Some(r) = &t.reasoning {
                if self.show_reasoning {
                    for line in clean(&r.text).lines().rev().take(4).collect::<Vec<_>>().into_iter().rev() {
                        top.push(TLine::new(TEXT_INDENT, TEXT_INDENT).s(line, Sty::Dim));
                    }
                }
                let mut l = TLine::row(2).s(format!("{} ", spinner(now)), Sty::Accent).s("thinking", Sty::Plain);
                l.push(format!("{mid}{}", timer(self.waited(r.start, r.paused0, now))), Sty::Dim);
                top.push(l);
            }
            if let Some((_, md)) = &t.text {
                top.extend(md.live());
            }
            let running: Vec<&Step> = t.run.steps.iter().filter(|s| matches!(s.state, StepState::Running | StepState::Preparing)).collect();
            for st in running.iter().rev().take(3).rev() {
                top.extend(self.step_live(st, now));
            }
            let done: Vec<&Step> = t.run.steps.iter().filter(|s| !matches!(s.state, StepState::Running | StepState::Preparing)).collect();
            if !done.is_empty() {
                let items: Vec<String> = done
                    .iter()
                    .rev()
                    .take(4)
                    .rev()
                    .map(|s| {
                        let m = match s.state {
                            StepState::Ok => g().ok,
                            _ => g().fail,
                        };
                        let mut x = format!("{m} {}", tool_name(&s.tool));
                        if s.added + s.removed > 0 {
                            x.push(' ');
                            x.push_str(&change(s.added, s.removed));
                        }
                        x
                    })
                    .collect();
                let label = if running.is_empty() { format!("{} done", done.len()) } else { format!("{} earlier", done.len()) };
                top.push(TLine::row(4).s(format!("{label}: {}", items.join(&mid)), Sty::Dim));
            }
            let quiet = t.reasoning.is_none() && running.is_empty() && t.text.as_ref().is_none_or(|(_, md)| md.live().is_empty());
            if quiet {
                // O1: from the turn's start until something shows, and in
                // the gaps between steps.
                let (from, p0) = if t.any { (t.activity, t.activity_paused0) } else { (t.start, t.paused0) };
                let mut l = TLine::row(2).s(format!("{} ", spinner(now)), Sty::Accent).s("thinking", Sty::Dim);
                l.push(format!("{mid}{}", timer(self.waited(from, p0, now))), Sty::Dim);
                top.push(l);
            }
        }
        // Pinned under the ask: the todo line, background subagents, queued.
        let mut pinned = Vec::new();
        if !self.todos.is_empty() {
            let done = self.todos.iter().filter(|t| t.status == "completed").count();
            let cur = self.todos.iter().find(|t| t.status == "in_progress").or_else(|| self.todos.iter().find(|t| t.status != "completed"));
            let what = cur.map(|t| t.active.clone().unwrap_or_else(|| t.content.clone())).unwrap_or_default();
            pinned.push(TLine::row(2).s(format!("{} ", g().half), Sty::Accent).s(format!("{done}/{} ", self.todos.len()), Sty::Bold).s(what, Sty::Plain));
        }
        for sub in self.subs.iter().filter(|x| x.sa.is_running() && x.sa.background) {
            let mut l = TLine::row(2).s(format!("{} background{mid}", g().half), Sty::Dim);
            for mut seg in self.subagent_segs(sub, now, false) {
                seg.sty = Sty::Dim;
                l.segs.push(seg);
            }
            pinned.push(l);
        }
        for q in &self.queued {
            let mut l = TLine::row(2).s("queued  ", Sty::Dim);
            if let Some(w) = &q.who {
                l.push(format!("{w}: "), Sty::Dim);
            }
            l.push(first_line(&q.text).to_string(), Sty::Dim);
            pinned.push(l);
        }
        (top, pinned)
    }

    fn step_live(&self, st: &Step, now: i64) -> Vec<TLine> {
        let mid = format!(" {} ", g().mid);
        let mut v = Vec::new();
        if let Some(id) = &st.subagent
            && let Some(sub) = self.subs.iter().find(|x| &x.sa.id == id)
            && !sub.sa.background
        {
            let mut l = TLine::row(2).s(format!("{} ", g().half), Sty::Accent);
            l.segs.extend(self.subagent_segs(sub, now, false));
            v.push(l);
            return v;
        }
        let mut l = TLine::row(2).s(format!("{} ", spinner(now)), Sty::Accent).s(tool_name(&st.tool), Sty::Bold);
        if !st.title.is_empty() {
            l.push(format!("  {}", st.title), Sty::Plain);
        }
        if st.state == StepState::Preparing {
            let mut w = format!("{mid}writing{}", g().ellipsis);
            if let Some(n) = st.lines {
                w.push_str(&format!(" {}", plural(n as usize, "line")));
            }
            l.push(w, Sty::Dim);
        }
        l.indent = 4;
        let waiting = st.state == StepState::Running && self.open_asks().next().is_some();
        let t = if waiting { "waiting for your answer".to_string() } else { timer(self.waited(st.start, st.paused0, now)) };
        v.push(right(l, t));
        for o in &st.output {
            v.push(TLine::row(4).s(o.clone(), Sty::Dim));
        }
        v
    }

    /// The status line: its left side, and the fact or hint on the right.
    pub fn status(&self, now: i64) -> (Vec<Seg>, String) {
        let mid = format!(" {} ", g().mid);
        let mut left = Vec::new();
        let (glyph, label, sty) = match &self.conn {
            Conn::Offline { retry_at } => {
                let secs = ((retry_at - now).max(0) as f64 / 1000.0).ceil() as u64;
                (g().fail, format!("offline{mid}retrying in {secs} s"), Sty::Err)
            }
            Conn::Connecting if crate::http::computer_starting() => (g().ring, "starting your computer".to_string(), Sty::Dim),
            Conn::Connecting => (g().ring, "connecting".to_string(), Sty::Dim),
            Conn::Online => {
                if let Some(r) = &self.runtime {
                    (g().ring, r.clone(), Sty::Dim)
                } else if crate::http::computer_starting() {
                    (g().ring, "starting your computer".to_string(), Sty::Dim)
                } else if self.open_asks().next().is_some() {
                    (g().ask, "waiting for you".to_string(), Sty::Warn)
                } else if self.turn.is_some() || self.status == "running" {
                    (g().dot, "running".to_string(), Sty::Ok)
                } else if self.status == "suspended" {
                    (g().suspended, "suspended".to_string(), Sty::Dim)
                } else if self.status == "starting" {
                    (g().ring, "starting".to_string(), Sty::Dim)
                } else {
                    (g().dot, "idle".to_string(), Sty::Dim)
                }
            }
        };
        // Only a state that asks for attention is as bright as the conversation.
        let label_sty = if matches!(sty, Sty::Dim) { Sty::Dim } else { Sty::Plain };
        left.push(Seg::new(format!("{glyph} "), sty));
        left.push(Seg::new(label, label_sty));
        let mut details = Vec::new();
        let q = self.queued.len();
        if q > 0 {
            details.push(format!("{q} queued"));
        }
        let subs = self.running_subagents();
        if subs > 0 {
            details.push(plural(subs, "subagent"));
        }
        if let Some((used, win)) = self.context
            && win > 0
            && used * 2 > win
        {
            details.push(format!("{} context", tokens(used)));
        }
        if self.compacting {
            details.push("compacting".into());
        }
        if self.slow {
            details.push("slow connection".into());
        }
        if let Some(until) = self.rate_limited_until
            && until > now
        {
            details.push(format!("rate limited{mid}{}", timer((until - now) as u64 + 999)));
        }
        if self.read_only {
            details.push("read-only".into());
        }
        for d in details {
            left.push(Seg::new(format!("{mid}{d}"), Sty::Dim));
        }
        let right = match &self.fact {
            Some((f, until)) if *until > now => f.clone(),
            _ => "ctrl+o details".to_string(),
        };
        (left, right)
    }

    /// The terminal title: `◆ flaky test in segment.test.ts`.
    pub fn term_title(&self) -> String {
        let glyph = if self.open_asks().next().is_some() {
            g().ask
        } else if self.turn.is_some() {
            g().dot
        } else {
            g().ring
        };
        let t = if self.title.trim().is_empty() { format!("opc {}", crate::ids::short(&self.session_id)) } else { self.title.clone() };
        format!("{glyph} {t}")
    }

    /// One line for the detach message: `running`, `idle`, `waiting`.
    pub fn state_word(&self) -> &str {
        if self.open_asks().next().is_some() {
            "waiting"
        } else if self.turn.is_some() {
            "running"
        } else if self.status.is_empty() {
            "idle"
        } else {
            &self.status
        }
    }
}

/// A permission mode in words; None for the usual one (a Computer runs with bypassPermissions).
pub fn mode_label(mode: &str) -> Option<String> {
    let l = match mode {
        "" | "default" | "bypassPermissions" => return None,
        "plan" => "plan mode",
        "acceptEdits" => "accept edits",
        "dontAsk" => "don't ask",
        other => other,
    };
    Some(l.to_string())
}

/// The speed for the header: the usual one, fast, is left out.
pub fn speed_label(speed: &str) -> Option<String> {
    match speed {
        "" | "fast" => None,
        other => Some(format!("{other} speed")),
    }
}

/// A permission mode as a choice in the /mode list.
pub fn mode_choice(mode: &str) -> String {
    match mode {
        "bypassPermissions" => "no approvals (usual)".into(),
        "default" => "ask before acting".into(),
        m => mode_label(m).unwrap_or_default(),
    }
}

/// `claude-opus-5-5` and `opus-5-5` as `opus 5.5`; other ids as they are.
pub fn pretty_model(id: &str) -> String {
    let id = id.strip_prefix("claude-").unwrap_or(id);
    let mut words = id.split('-');
    let Some(name) = words.next() else {
        return id.to_string();
    };
    let nums: Vec<&str> = words.collect();
    if nums.is_empty() || nums.len() > 2 || !nums.iter().all(|n| !n.is_empty() && n.bytes().all(|b| b.is_ascii_digit())) {
        return id.to_string();
    }
    format!("{name} {}", nums.join("."))
}

struct Ending {
    kind: String,
    text: Option<String>,
    silent: bool,
    dur_ms: Option<u64>,
    reason: Option<String>,
    error: Option<String>,
}

/// Puts `text` at the right edge of a live row.
pub fn right(mut l: TLine, text: String) -> TLine {
    l.segs.push(Seg { text, sty: Sty::Dim, link: Some(RIGHT.to_string()) });
    l
}

/// Marks a segment that is drawn flush right (live rows only).
pub const RIGHT: &str = "\u{0}right";

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: u64, kind: &str, turn: &str, data: Value) -> Event {
        Event(json!({"seq": seq, "type": kind, "sessionId": "cs_test", "turnId": turn, "actor": null, "data": data, "createdAt": "2026-10-26T09:00:00Z"}))
    }
    fn ev_by(seq: u64, kind: &str, turn: &str, actor: Value, data: Value) -> Event {
        Event(json!({"seq": seq, "type": kind, "sessionId": "cs_test", "turnId": turn, "actor": actor, "data": data}))
    }
    fn delta(kind: &str, turn: &str, data: Value) -> Delta {
        Delta(json!({"type": kind, "sessionId": "cs_test", "turnId": turn, "data": data}))
    }
    fn texts(m: &mut Model) -> Vec<String> {
        m.take_out().iter().map(|l| l.plain()).collect()
    }
    fn live_text(m: &Model, now: i64) -> Vec<String> {
        let (a, b) = m.live(now);
        a.iter().chain(b.iter()).map(|l| l.segs.iter().filter(|s| s.link.as_deref() != Some(RIGHT)).map(|s| s.text.as_str()).collect::<String>().trim_end().to_string()).collect()
    }
    fn model() -> Model {
        let mut m = Model::new("cs_test", false);
        m.me = Some("usr_me".into());
        m.conn = Conn::Online;
        m
    }
    fn me() -> Value {
        json!({"id": "usr_me", "name": "Ada", "via": "opc"})
    }
    fn tool(seq: u64, call: &str, name: &str, title: &str) -> Event {
        ev(seq, "tool.started", "tn_1", json!({"toolName": name, "callId": call, "parentCallId": null, "subagentId": null, "title": title, "input": {}}))
    }
    fn done(seq: u64, call: &str, ms: u64) -> Event {
        ev(seq, "tool.completed", "tn_1", json!({"toolName": "x", "callId": call, "durationMs": ms, "fileChanges": null}))
    }

    #[test]
    fn steps_fold_into_one_line_when_the_agent_writes() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        texts(&mut m);
        m.event(&tool(2, "c1", "Read", "src/a.ts"), 100);
        m.event(&done(3, "c1", 50), 150);
        m.event(&tool(4, "c2", "Read", "src/b.ts"), 200);
        m.event(&ev(5, "tool.failed", "tn_1", json!({"toolName": "Grep", "callId": "c2", "message": "no match", "settledBy": null})), 300);
        m.event(&tool(6, "c3", "Edit", "src/a.ts"), 400);
        m.event(&ev(7, "tool.completed", "tn_1", json!({"callId": "c3", "fileChanges": [{"path": "src/a.ts", "status": "modified", "added": 12, "removed": 3}]})), 6400);
        // Still live: nothing settled.
        assert!(texts(&mut m).is_empty());
        let live = live_text(&m, 6500);
        assert!(live.iter().any(|l| l.contains("3 done: ✓ Read · ✗ Read · ✓ Edit +12 −3")), "{live:?}");
        m.delta(&delta("message.delta", "tn_1", json!({"blockId": "b1", "text": "Fixed it. "})), 6600);
        assert_eq!(texts(&mut m), vec!["  ✓ Ran 3 steps · Read ×2, Edit · 6.3 s · +12 −3 · 1 failed"]);
    }

    #[test]
    fn a_run_of_one_step_stays_that_step_and_the_turn_ends_with_a_summary() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.event(&ev(2, "tool.started", "tn_1", json!({"toolName": "Bash", "callId": "c1", "title": "npm test", "input": {"command": "npm test", "description": "Run the suite"}})), 10);
        m.event(&done(3, "c1", 4100), 4110);
        m.event(&ev(4, "message.completed", "tn_1", json!({"blockId": "b1", "text": "All green."})), 4200);
        m.event(&ev(5, "turn.completed", "tn_1", json!({"text": "All green.", "durationMs": 72_000})), 4300);
        let out = texts(&mut m);
        assert_eq!(out, vec!["  ✓ Bash  Run the suite · 4.1 s", "  All green.", "  ── 1m 12s · 1 step"]);
    }

    #[test]
    fn a_cut_run_is_marked_failed() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.event(&tool(2, "c1", "Bash", "sleep 100"), 10);
        m.event(&ev(3, "tool.failed", "tn_1", json!({"callId": "c1", "settledBy": "turn.cancelled"})), 3000);
        m.event(&ev(4, "turn.cancelled", "tn_1", json!({"reason": "interrupted", "durationMs": 3000})), 3000);
        let out = texts(&mut m);
        assert_eq!(out, vec!["  ✗ Bash  sleep 100 · 3.0 s", "  ── interrupted · 3.0 s · 1 step"]);
    }

    #[test]
    fn thinking_shows_a_timer_and_the_run_says_thought() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        // O1: a placeholder before anything arrives.
        assert_eq!(live_text(&m, 8000).last().unwrap().split_once(' ').unwrap().1, "thinking · 8 s");
        m.delta(&delta("reasoning.delta", "tn_1", json!({"blockId": "r1", "text": "hmm"})), 8000);
        m.event(&ev(2, "reasoning.completed", "tn_1", json!({"blockId": "r1", "text": "hmm", "durationMs": 6000})), 14_000);
        m.event(&tool(3, "c1", "Read", "a"), 14_100);
        m.event(&done(4, "c1", 10), 14_200);
        m.event(&ev(5, "message.completed", "tn_1", json!({"blockId": "b1", "text": "ok"})), 14_300);
        let out = texts(&mut m);
        assert_eq!(out[0], "  ✓ Read  a · thought 6.0 s");
    }

    #[test]
    fn our_message_is_sending_then_settles_and_queued_waits_for_its_turn() {
        let mut m = model();
        let id = m.send_local("fix the test", false);
        assert_eq!(live_text(&m, 0)[0], "you   fix the test  sending");
        m.sent(id, Ok(&json!({"turn": {"id": "tn_1"}, "delivery": "started", "seq": 3})), 10);
        // The event echo after the response is not printed twice.
        m.event(&ev_by(3, "message.received", "tn_1", me(), json!({"input": "fix the test", "delivery": "started"})), 20);
        m.event(&ev(4, "turn.started", "tn_1", json!({})), 20);
        assert_eq!(texts(&mut m), vec!["you   fix the test"]);

        let q = m.send_local("then run the suite", true);
        m.event(&ev_by(5, "message.received", "tn_2", me(), json!({"input": "then run the suite", "delivery": "queued"})), 30);
        m.event(&ev(6, "turn.queued", "tn_2", json!({"position": 1})), 30);
        m.sent(q, Ok(&json!({"turn": {"id": "tn_2"}, "delivery": "queued", "seq": 6})), 40);
        assert!(texts(&mut m).is_empty());
        assert_eq!(m.queued.len(), 1);
        assert!(live_text(&m, 50).contains(&"queued  then run the suite".to_string()));
        let (left, _) = m.status(50);
        assert!(left.iter().map(|s| s.text.clone()).collect::<String>().contains("1 queued"));
        m.event(&ev(7, "turn.completed", "tn_1", json!({"durationMs": 100})), 60);
        m.event(&ev(8, "turn.started", "tn_2", json!({})), 60);
        let out = texts(&mut m);
        assert_eq!(out.last().unwrap(), "you   then run the suite");
        assert!(m.queued.is_empty());
    }

    #[test]
    fn a_steered_message_is_marked_read_when_the_agent_takes_it() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        let id = m.send_local("also add a test", false);
        m.sent(id, Ok(&json!({"turn": {"id": "tn_1"}, "delivery": "steered", "seq": 2})), 10);
        assert!(live_text(&m, 20)[0].starts_with("you   also add a test  ↳"));
        m.event(&ev(3, "turn.steered", "tn_1", json!({})), 30);
        assert_eq!(texts(&mut m), vec!["you   also add a test  ↳ read"]);
    }

    #[test]
    fn other_people_are_named_with_where_they_wrote() {
        let mut m = model();
        m.event(&ev_by(1, "message.received", "tn_1", json!({"id": "usr_mo", "name": "Mo", "via": "slack"}), json!({"input": "look at CI too", "delivery": "started"})), 0);
        m.event(&ev(2, "turn.started", "tn_1", json!({})), 0);
        assert_eq!(texts(&mut m), vec!["Mo · slack", "      look at CI too"]);
    }

    #[test]
    fn a_self_started_turn_has_an_agent_header_not_an_empty_you() {
        let mut m = model();
        let sa = json!({"id": "sa_1", "name": "auth flow", "agentType": "Explore", "background": true, "status": "running", "toolCalls": 0, "tokens": 0});
        m.event(&ev(1, "subagent.started", "tn_0", json!({"subagent": sa})), 0);
        let mut ended = sa.clone();
        ended["status"] = json!("completed");
        ended["durationMs"] = json!(240_000);
        m.event(&ev(2, "subagent.ended", "tn_0", json!({"subagent": ended})), 240_000);
        m.event(&ev(3, "turn.started", "tn_9", json!({"subagentId": "sa_1"})), 240_100);
        let out = texts(&mut m);
        assert_eq!(out, vec!["  ✓ background subagent \"auth flow\" finished · 4m · /subagents to read", "agent ↳ background subagent \"auth flow\" finished"]);
        assert_eq!(m.take_effects(), vec![Effect::Notify("background subagent \"auth flow\" finished".into())]);
        // Without subagentId and without a message: still the agent's.
        m.event(&ev(4, "turn.completed", "tn_9", json!({})), 240_200);
        texts(&mut m);
        m.event(&ev(5, "turn.started", "tn_10", json!({})), 240_300);
        assert_eq!(texts(&mut m), vec!["agent"]);
    }

    #[test]
    fn foreground_subagents_show_live_and_fold() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.event(&tool(2, "toolu_t", "Task", "auth flow"), 0);
        let sa = json!({"id": "sa_1", "callId": "toolu_t", "name": "auth flow", "agentType": "Explore", "background": false, "status": "running", "toolCalls": 0, "tokens": 0});
        m.event(&ev(3, "subagent.started", "tn_1", json!({"subagent": sa})), 0);
        m.delta(&delta("subagent.progress", "tn_1", json!({"subagentId": "sa_1", "activity": "reading src/auth/session.ts", "toolCalls": 14, "tokens": 9000})), 72_000);
        assert!(live_text(&m, 72_000).contains(&"◐ Explore · auth flow · reading src/auth/session.ts · 14 tools · 1m 12s".to_string()));
        let (left, _) = m.status(72_000);
        assert_eq!(left.iter().map(|s| s.text.clone()).collect::<String>(), "● running · 1 subagent");
        // Its own tool calls do not join the run.
        m.event(&ev(4, "tool.started", "tn_1", json!({"toolName": "Read", "callId": "c9", "subagentId": "sa_1", "parentCallId": "toolu_t"})), 73_000);
        let mut ended = sa.clone();
        ended["status"] = json!("completed");
        ended["toolCalls"] = json!(41);
        ended["durationMs"] = json!(180_000);
        m.event(&ev(5, "subagent.ended", "tn_1", json!({"subagent": ended})), 180_000);
        m.event(&done(6, "toolu_t", 180_000), 180_000);
        m.event(&ev(7, "message.completed", "tn_1", json!({"blockId": "b", "text": "Found it."})), 180_100);
        assert_eq!(texts(&mut m)[0], "  ✓ Explore · auth flow · 41 tools · 3m");
        let (left, _) = m.status(180_200);
        assert_eq!(left.iter().map(|s| s.text.clone()).collect::<String>(), "● running");
    }

    #[test]
    fn background_subagents_are_pinned_and_counted_while_idle() {
        let mut m = model();
        let sa = json!({"id": "sa_2", "name": "auth flow", "agentType": "Explore", "background": true, "status": "running", "toolCalls": 3, "tokens": 0});
        m.event(&ev(1, "subagent.started", "tn_1", json!({"subagent": sa})), 0);
        let live = live_text(&m, 5000);
        assert_eq!(live, vec!["◐ background · Explore · auth flow · 3 tools · 5 s"]);
        let (left, _) = m.status(5000);
        assert_eq!(left.iter().map(|s| s.text.clone()).collect::<String>(), "● idle · 1 subagent");
    }

    #[test]
    fn interrupt_says_when_background_subagents_survive() {
        let mut m = model();
        let sa = json!({"id": "sa_2", "name": "x", "background": true, "status": "running"});
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.event(&ev(2, "subagent.started", "tn_1", json!({"subagent": sa.clone()})), 0);
        m.interrupting(100);
        m.event(&ev(3, "turn.cancelled", "tn_1", json!({"reason": "interrupted"})), 200);
        m.tick(1000);
        assert_eq!(m.status(1000).1, "ctrl+o details");
        m.tick(1800);
        assert_eq!(m.status(1800).1, "interrupted · 1 background subagent still running · /subagents");

        // When the harness stopped it too, nothing is said.
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.event(&ev(2, "subagent.started", "tn_1", json!({"subagent": sa.clone()})), 0);
        m.interrupting(100);
        m.event(&ev(3, "turn.cancelled", "tn_1", json!({"reason": "interrupted"})), 200);
        let mut stopped = sa;
        stopped["status"] = json!("stopped");
        m.event(&ev(4, "subagent.ended", "tn_1", json!({"subagent": stopped})), 400);
        m.tick(2000);
        assert_eq!(m.status(2000).1, "ctrl+o details");
    }

    #[test]
    fn asks_wait_for_you_freeze_timers_and_say_who_answered() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.event(&tool(2, "c1", "Bash", "terraform plan"), 0);
        let ask = json!({"id": "ak_1", "kind": "approval", "status": "open", "approval": {"toolName": "Bash", "title": "terraform plan", "input": {}}});
        m.event(&ev(3, "ask.opened", "tn_1", json!({"ask": ask})), 2000);
        assert_eq!(m.status(2000).0.iter().map(|s| s.text.clone()).collect::<String>(), "◆ waiting for you");
        assert_eq!(m.take_effects(), vec![Effect::Notify("needs you: approval for \"terraform plan\"".into())]);
        // O6: the step waits, and its timer does not count the wait.
        assert_eq!(m.live(60_000).0.last().unwrap().segs.last().unwrap().text, "waiting for your answer");
        let mut closed = ask.clone();
        closed["status"] = json!("answered");
        closed["answer"] = json!({"decision": "allow"});
        m.event(&ev_by(4, "ask.closed", "tn_1", json!({"id": "usr_mo", "name": "Mo", "via": "slack"}), json!({"ask": closed})), 60_000);
        assert_eq!(texts(&mut m).last().unwrap(), "  ✓ allowed by Mo in Slack · terraform plan");
        assert_eq!(m.live(63_000).0.last().unwrap().segs.last().unwrap().text, "5 s");
        let mut declined = ask;
        declined["id"] = json!("ak_2");
        declined["status"] = json!("declined");
        m.event(&ev_by(5, "message.received", "tn_1", me(), json!({"input": "use the staging bucket, not prod", "delivery": "steered", "declinedAskIds": ["ak_2"]})), 64_000);
        m.event(&ev(6, "ask.closed", "tn_1", json!({"ask": declined})), 64_000);
        assert_eq!(texts(&mut m).last().unwrap(), "  ✗ declined · use the staging bucket, not prod");
    }

    #[test]
    fn catch_up_never_notifies() {
        let mut m = model();
        m.catchup_seq = 10;
        let ask = json!({"id": "ak_1", "kind": "question", "status": "open"});
        m.event(&ev(3, "ask.opened", "tn_1", json!({"ask": ask})), 0);
        assert!(m.take_effects().is_empty());
        m.event(&ev(11, "ask.opened", "tn_1", json!({"ask": {"id": "ak_2", "kind": "question", "status": "open"}})), 0);
        assert_eq!(m.take_effects().len(), 1);
    }

    #[test]
    fn preparing_steps_show_what_is_being_written() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        m.delta(&delta("tool.preparing", "tn_1", json!({"callId": "c1", "toolName": "Write", "path": "src/x.ts", "lines": 212})), 100);
        assert_eq!(live_text(&m, 200)[0], format!("{} Write  src/x.ts · writing… 212 lines", crate::ui::spinner(200)));
        m.event(&ev(2, "tool.started", "tn_1", json!({"toolName": "Write", "callId": "c1", "title": "src/x.ts", "input": {}})), 300);
        let l = live_text(&m, 400);
        assert!(l[0].ends_with("Write  src/x.ts"), "{l:?}");
        assert_eq!(l.len(), 1);
    }

    #[test]
    fn todos_pin_one_line_and_print_each_finished_item_once() {
        let mut m = model();
        m.event(&ev(1, "turn.started", "tn_1", json!({})), 0);
        let todos = |a: &str, b: &str| json!({"toolName": "TodoWrite", "callId": "t", "input": {"todos": [
            {"content": "Read the code", "status": a, "activeForm": "Reading the code"},
            {"content": "Run the suite", "status": b, "activeForm": "Running the suite"},
            {"content": "Open a PR", "status": "pending", "activeForm": "Opening a PR"}]}});
        m.event(&ev(2, "tool.started", "tn_1", todos("completed", "in_progress")), 0);
        m.event(&ev(3, "tool.started", "tn_1", todos("completed", "in_progress")), 0);
        assert_eq!(texts(&mut m), vec!["  ✓ Read the code"]);
        assert!(live_text(&m, 0).contains(&"◐ 1/3 Running the suite".to_string()));
        m.event(&ev(4, "tool.started", "tn_1", todos("completed", "completed")), 0);
        assert_eq!(texts(&mut m), vec!["  ✓ Run the suite"]);
    }

    #[test]
    fn compacting_and_silent_turns() {
        let mut m = model();
        m.delta(&delta("session.compacting", "", json!({})), 0);
        assert!(m.status(0).0.iter().any(|s| s.text.contains("compacting")));
        m.event(&ev(1, "session.compacted", "", json!({"beforeTokens": 180_000, "afterTokens": 22_000})), 0);
        assert!(!m.status(0).0.iter().any(|s| s.text.contains("compacting")));
        assert_eq!(texts(&mut m), vec!["  ── conversation compacted · 180k → 22k"]);
        m.event(&ev(2, "turn.started", "tn_1", json!({})), 0);
        m.event(&ev(3, "turn.completed", "tn_1", json!({"text": "", "silent": true, "durationMs": 900})), 900);
        let out = texts(&mut m);
        assert!(out.contains(&"  (no reply)".to_string()), "{out:?}");
    }

    #[test]
    fn a_failed_send_comes_back_to_the_prompt() {
        let mut m = model();
        let id = m.send_local("hello", false);
        let e = crate::error::Error::new("forbidden", "read-only");
        m.sent(id, Err(&e), 0);
        assert_eq!(m.take_effects(), vec![Effect::Restore("hello".into())]);
        assert!(m.outgoing.is_empty());
    }

    #[test]
    fn odd_server_data_does_not_panic() {
        let mut m = model();
        for kind in ["turn.started", "tool.started", "tool.completed", "ask.opened", "ask.closed", "subagent.started", "subagent.ended", "session.updated", "message.completed", "turn.completed", "whatever"] {
            m.event(&Event(json!({"type": kind, "data": null})), 0);
            m.event(&Event(json!({"type": kind, "turnId": 5, "data": {"ask": 3, "subagent": "x", "changes": [1]}})), 0);
        }
        for kind in ["message.delta", "tool.preparing", "subagent.progress", "tool.delta", "reasoning.delta"] {
            m.delta(&Delta(json!({"type": kind})), 0);
        }
        let _ = m.live(0);
        let _ = m.status(0);
    }

    #[test]
    fn settings_read_as_words() {
        assert_eq!(pretty_model("claude-opus-5-5"), "opus 5.5");
        assert_eq!(pretty_model("claude-haiku-5"), "haiku 5");
        assert_eq!(pretty_model("gpt-5.1-codex"), "gpt-5.1-codex");
        assert_eq!(mode_label("bypassPermissions"), None);
        assert_eq!(mode_label("plan").as_deref(), Some("plan mode"));
        assert_eq!(mode_choice("default"), "ask before acting");
    }

    #[test]
    fn speed_shows_in_the_header_only_when_not_fast() {
        let mut m = model();
        m.title = "t".into();
        assert!(!m.header_line().plain().contains("speed"));
        m.settings.speed = Some("fast".into());
        assert!(!m.header_line().plain().contains("speed"));
        m.event(&ev(1, "session.updated", "", json!({"changes": {"speed": {"from": null, "to": "standard"}}})), 0);
        assert_eq!(m.settings.speed.as_deref(), Some("standard"));
        assert!(m.header_line().plain().contains("standard speed"), "{}", m.header_line().plain());
        assert!(texts(&mut m).iter().any(|l| l.contains("speed: fast → standard")));
    }
}
