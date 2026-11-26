//! The session screen's loop: the connection, the keyboard, the model and
//! the requests in flight, in one task. Requests run as futures polled by
//! the loop itself, so the screen never waits on the network.

use std::collections::HashSet;
use std::future::Future;
use std::io::Write;
use std::path::PathBuf;
use std::pin::Pin;
use std::time::{Duration, Instant};

use crossterm::event::{Event as TermEvent, EventStream, KeyCode, KeyEvent, KeyEventKind, KeyModifiers};
use futures_util::stream::{FuturesUnordered, StreamExt};
use serde_json::{Map, Value, json};
use tokio::sync::mpsc::UnboundedReceiver;

use super::ask::{AskOut, AskUi, is_plan, plan_text};
use super::draw::Painter;
use super::list::{Item, List, Pick};
use super::model::{Conn, Effect, Model, TEXT_INDENT};
use super::notify::Notifier;
use super::prompt::{Edit, Editor};
use super::slash::{self, Cmd, Line};
use super::text::Md;
use super::view::{self, Live};
use super::{Seg, Sty, TLine, details, first_line, g, now_ms, plural, term, truncate};
use crate::api::types::{Event, Session};
use crate::cmd::Ctx;
use crate::error::{Error, Result};
use crate::telemetry::{self, Control};
use crate::wire::{Attach, Wire, WireEvent, WireHandle, WireOptions};

/// Keys pressed this soon after an ask takes the keyboard are ignored.
const ASK_GUARD_MS: i64 = 300;
/// An ask takes the keyboard after this long without a key, prompt empty.
const ASK_IDLE_MS: i64 = 500;
const CTRL_C_MS: i64 = 2_000;
/// The terminal is gone after this many read errors in a row.
const TERM_ERRORS: u32 = 5;

/// How the screen was left.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Exit {
    Detach,
    /// `/new`: start a new session.
    New,
    /// The picker chose another session.
    Attach(String),
}

/// A session to create, for `opc` without `-s`.
#[derive(Debug, Clone)]
pub struct Create {
    /// `{id, model, effort, speed, mode, title, metadata}`, without `input`.
    pub body: Value,
    /// The idempotency key the requests derive theirs from.
    pub key: String,
    pub push: Vec<PathBuf>,
}

/// Everything the screen starts from.
pub struct Start {
    pub session_id: String,
    pub read_only: bool,
    pub attach: Attach,
    /// Cached events drawn before the network answers (only the last
    /// `shown_from` onward are printed).
    pub cached: Vec<Event>,
    pub cached_shown_from: usize,
    /// Events may be appended to the local cache.
    pub cache_writes: bool,
    pub create: Option<Create>,
    /// A message to send at once.
    pub message: Option<String>,
    /// Print the one-line earlier turns the attach returns.
    pub earlier: bool,
    pub launched: Instant,
}

type Fut<'a> = Pin<Box<dyn Future<Output = Bg> + 'a>>;
type Fetch<'a> = Pin<Box<dyn Future<Output = Result<Vec<Session>>> + 'a>>;

/// A request that finished.
enum Bg {
    Created { out: Option<u64>, session: Result<Value>, sent: Option<Result<Value>>, notes: Vec<String> },
    Sent { out: u64, result: Result<Value> },
    Me(Value),
    /// The connection's URL, found with `/me`.
    WireUrl(Result<String>),
    Answered { ask: String, always: Option<String>, key: u64, result: Result<Value> },
    Sessions(Vec<Session>),
    SubResult { name: String, result: Result<Value> },
    Archived(Result<Value>),
    /// A line for the transcript, or an error message.
    Note(String),
    Fail(String),
    Unqueued { text: String, key: u64, result: Result<Value> },
    /// An interrupt's answer: the telemetry key, and the error to show.
    Interrupted { key: u64, fail: Option<String> },
    Quiet,
}

/// The values of the `speed` setting.
const SPEEDS: [&str; 2] = ["fast", "standard"];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ListKind {
    Sessions,
    Model,
    Effort,
    Speed,
    Mode,
    Subagents,
}

enum CreateState {
    /// The session exists.
    Exists,
    /// Created on the first message.
    Lazy(Create),
    /// The create is in flight.
    Creating(Create),
}

struct Timing {
    launched: Instant,
    first_frame: Option<Duration>,
    connected: Option<Duration>,
    attached: Option<Duration>,
}

struct App<'a> {
    ctx: &'a Ctx,
    m: Model,
    ed: Editor,
    wire: Option<WireHandle>,
    futs: FuturesUnordered<Fut<'a>>,
    painter: Painter,
    ask: Option<AskUi>,
    ask_focus: bool,
    ask_focus_at: i64,
    /// The ask already took the keyboard once on its own.
    ask_auto_done: bool,
    /// Answered here, waiting for `ask.closed`.
    answered: HashSet<String>,
    shown_plans: HashSet<String>,
    list: Option<(ListKind, List)>,
    notice: Vec<TLine>,
    last_key: i64,
    ctrl_c_at: Option<i64>,
    focused: Option<bool>,
    notifier: Notifier,
    exit: Option<Exit>,
    create: CreateState,
    key_base: String,
    /// Messages waiting for the connection or the create: (out id, queue).
    unsent: Vec<(u64, bool)>,
    log_epoch: Option<u64>,
    cache_writes: bool,
    pending_truncate: Option<u64>,
    batch: Vec<Event>,
    me: Option<String>,
    reattach: bool,
    attached_ok: bool,
    show_earlier: bool,
    timing: Timing,
    title_shown: String,
    dirty: bool,
    last_draw: i64,
    size: (usize, usize),
    sessions: Vec<Session>,
    /// SIGTERM or SIGHUP ended the screen: the exit code.
    killed: Option<i32>,
    /// Client telemetry: turns, controls and draws measured here.
    tel: telemetry::Screen,
    render_failed: bool,
}

fn env(k: &str) -> Option<String> {
    std::env::var(k).ok()
}

fn size() -> (usize, usize) {
    crossterm::terminal::size().map(|(w, h)| (w.max(10) as usize, h.max(4) as usize)).unwrap_or((80, 24))
}

/// Runs the session screen until the person leaves it. The terminal is put
/// back on every path, including errors and panics.
pub async fn session(ctx: &Ctx, start: Start) -> Result<Exit> {
    // The status line says it; a line on stderr would tear the screen.
    crate::http::set_starting_notice(None);
    let guard = term::enter().map_err(|e| Error::usage(format!("cannot use the terminal: {e}")))?;
    let mut app = App::new(ctx, &start);
    telemetry::set_renderer();
    // The first frame, before any network.
    app.draw(true);
    app.timing.first_frame = Some(start.launched.elapsed());
    crate::timing::get().mark_prompt();
    let r = app.run(start).await;
    app.finish(r.as_ref().err());
    drop(guard);
    if let Some(code) = app.killed {
        std::process::exit(code);
    }
    r
}

impl<'a> App<'a> {
    fn new(ctx: &'a Ctx, start: &Start) -> App<'a> {
        let mut m = Model::new(&start.session_id, start.read_only);
        // Cached events: the person sees the session at once.
        if !start.cached.is_empty() {
            m.catchup_seq = start.cached.last().map(Event::seq).unwrap_or(0);
            let now = now_ms();
            let earlier = start.cached[..start.cached_shown_from.min(start.cached.len())].iter().filter(|e| e.kind() == "turn.started").count();
            for (i, e) in start.cached.iter().enumerate() {
                m.event(e, now);
                if i + 1 == start.cached_shown_from {
                    let _ = m.take_out();
                    let _ = m.take_effects();
                    if earlier > 0 {
                        m.print(TLine::row(2).s(format!("{} {} {} Ctrl+O for all", g().rule.repeat(2), plural(earlier, "earlier turn"), g().mid), Sty::Dim));
                    }
                }
            }
            let _ = m.take_effects();
        }
        let create = match &start.create {
            Some(c) if start.message.is_none() && c.push.is_empty() => CreateState::Lazy(c.clone()),
            Some(c) => CreateState::Creating(c.clone()),
            None => CreateState::Exists,
        };
        App {
            ctx,
            m,
            ed: Editor::new(crate::cache::history()),
            wire: None,
            futs: FuturesUnordered::new(),
            painter: Painter::new(ctx.color),
            ask: None,
            ask_focus: false,
            ask_focus_at: 0,
            ask_auto_done: false,
            answered: HashSet::new(),
            shown_plans: HashSet::new(),
            list: None,
            notice: Vec::new(),
            last_key: now_ms(),
            ctrl_c_at: None,
            focused: None,
            notifier: Notifier::from_env(env),
            exit: None,
            create,
            key_base: start.create.as_ref().map(|c| c.key.clone()).unwrap_or_else(crate::ids::idempotency_key),
            unsent: Vec::new(),
            log_epoch: None,
            cache_writes: start.cache_writes,
            pending_truncate: None,
            batch: Vec::new(),
            me: None,
            reattach: false,
            attached_ok: false,
            show_earlier: start.earlier,
            timing: Timing { launched: start.launched, first_frame: None, connected: None, attached: None },
            title_shown: String::new(),
            dirty: true,
            last_draw: 0,
            size: size(),
            sessions: Vec::new(),
            killed: None,
            tel: telemetry::Screen::new(&start.session_id),
            render_failed: false,
        }
    }

    fn id(&self) -> String {
        self.m.session_id.clone()
    }

    async fn run(&mut self, start: Start) -> Result<Exit> {
        let mut keys = EventStream::new();
        // The connection. Its URL may need `/me` the first time against a
        // non-default API: that happens alongside the keys, never before them.
        let mut rx: Option<UnboundedReceiver<WireEvent>> = None;
        match self.ctx.wire_url_now() {
            Some(url) => rx = Some(self.open_wire(url, &start)?),
            None => {
                let ctx = self.ctx;
                self.futs.push(Box::pin(async move { Bg::WireUrl(ctx.wire_url().await) }));
            }
        }
        self.m.connecting();
        let http = self.ctx.http.clone();
        self.futs.push(Box::pin(async move { http.get("/me", &[]).await.map(Bg::Me).unwrap_or(Bg::Quiet) }));
        if let CreateState::Creating(c) = &self.create {
            let c = c.clone();
            let out = start.message.as_deref().map(|t| self.m.send_local(t, false));
            if let Some(o) = out {
                // `opc "…"`: the command line's Enter started the turn.
                self.tel.entered(o, start.launched);
            }
            self.start_create(c, out, start.message.clone());
        }
        let mut tick = tokio::time::interval(Duration::from_millis(16));
        tick.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
        let mut stop = std::pin::pin!(term::stop_signal());
        let mut term_errors = 0;
        loop {
            enum Step {
                Wire(Option<WireEvent>),
                Term(Option<std::io::Result<TermEvent>>),
                Bg(Bg),
                Tick,
                Stop(i32),
            }
            let step = tokio::select! {
                ev = async { rx.as_mut().expect("guarded").recv().await }, if rx.is_some() => Step::Wire(ev),
                k = keys.next() => Step::Term(k),
                Some(b) = self.futs.next(), if !self.futs.is_empty() => Step::Bg(b),
                code = &mut stop => Step::Stop(code),
                _ = tick.tick() => Step::Tick,
            };
            if !matches!(step, Step::Term(Some(Err(_)))) {
                term_errors = 0;
            }
            match step {
                Step::Stop(code) => {
                    self.killed = Some(code);
                    return Ok(Exit::Detach);
                }
                Step::Wire(None) => return Err(Error::unreachable("the connection closed")),
                Step::Wire(Some(ev)) => {
                    self.wire_event(ev)?;
                    // Drain what is already here before drawing.
                    while let Some(Ok(ev)) = rx.as_mut().map(|r| r.try_recv()) {
                        self.wire_event(ev)?;
                    }
                    self.dirty = true;
                }
                Step::Term(None) => self.exit = Some(Exit::Detach),
                Step::Term(Some(Err(_))) => {
                    term_errors += 1;
                    if term_errors >= TERM_ERRORS {
                        self.exit = Some(Exit::Detach);
                    }
                }
                Step::Term(Some(Ok(ev))) => {
                    self.term_event(ev).await;
                    self.dirty = true;
                }
                Step::Bg(Bg::WireUrl(url)) => {
                    rx = Some(self.open_wire(url?, &start)?);
                    self.dirty = true;
                }
                Step::Bg(b) => {
                    self.bg(b);
                    self.dirty = true;
                }
                Step::Tick => {}
            }
            self.flush_cache();
            if let Some(e) = self.exit.take() {
                return Ok(e);
            }
            self.draw(false);
        }
    }

    // ---- the connection ---------------------------------------------------

    /// Opens the connection, attached to the session unless it is still to
    /// be created on the first send.
    fn open_wire(&mut self, url: String, start: &Start) -> Result<UnboundedReceiver<WireEvent>> {
        let opts = WireOptions {
            url,
            key: self.ctx.require_key()?.to_string(),
            deltas: true,
            resume: !start.read_only,
            read_only: start.read_only,
            give_up: None,
        };
        let attaches = match &self.create {
            CreateState::Lazy(_) => vec![],
            _ => {
                let mut a = start.attach.clone();
                a.session_id = self.m.session_id.clone();
                vec![a]
            }
        };
        let (wire, rx) = Wire::open(opts, attaches, Some(self.ctx.http.clone()));
        self.wire = Some(wire);
        Ok(rx)
    }

    fn wire_event(&mut self, ev: WireEvent) -> Result<()> {
        let now = now_ms();
        let id = self.id();
        match ev {
            WireEvent::Connected { took, .. } => {
                if self.timing.connected.is_none() {
                    self.timing.connected = Some(took);
                }
                self.m.online();
                self.flush_unsent();
            }
            WireEvent::Reconnecting { retry_in, .. } => {
                self.m.offline(now + retry_in.as_millis() as i64);
            }
            WireEvent::Attached { session_id, result } if session_id == id => match result {
                Ok(info) => {
                    if self.timing.attached.is_none() {
                        self.timing.attached = Some(self.timing.launched.elapsed());
                        crate::timing::get().mark_ready();
                    }
                    if let Some(from) = self.pending_truncate.take() {
                        crate::cache::truncate_events(&id, info.log_epoch, from);
                    }
                    self.log_epoch = Some(info.log_epoch);
                    let first = !self.m.attached_once;
                    self.m.attached(&info, now);
                    if first {
                        if let Some(t) = info.earlier_turns.as_ref().filter(|_| self.show_earlier) {
                            self.m.earlier(t);
                        }
                        crate::cache::set_last_session(&id);
                    }
                    crate::cache::upsert_session(self.ctx.http.api_url(), &info.session);
                    self.attached_ok = true;
                    self.reattach = false;
                }
                Err(e) => {
                    let creating = !matches!(self.create, CreateState::Exists);
                    if creating || (e.code == "session_not_found" && self.reattach) {
                        self.reattach = true;
                    } else if !self.m.attached_once {
                        return Err(e);
                    } else {
                        self.m.error(&e.message);
                    }
                }
            },
            WireEvent::Attached { .. } => {}
            WireEvent::Event(e) => {
                if e.session_id() == id || e.session_id().is_empty() {
                    self.tel_event(&e);
                    self.m.event(&e, now);
                    if self.cache_writes {
                        self.batch.push(e);
                    }
                    self.show_plans();
                }
            }
            WireEvent::Delta(d) => {
                if d.session_id() == id || d.session_id().is_empty() {
                    self.tel.received(d.turn_id(), d.kind(), Instant::now());
                }
                self.m.delta(&d, now)
            }
            WireEvent::EpochReset { session_id, epoch_start_seq } if session_id == id => {
                self.flush_cache();
                self.m.epoch_reset(epoch_start_seq);
                self.pending_truncate = Some(epoch_start_seq);
            }
            WireEvent::Detached { session_id, reason } if session_id == id => {
                self.m.error(&format!("the server stopped sending this session's events ({reason}); attaching again"));
                if let Some(w) = &self.wire {
                    w.attach(Attach { session_id: id, after: Some(self.m.last_seq), tail_turns: None, log_epoch: self.log_epoch });
                }
            }
            WireEvent::Fatal(e) => return Err(e),
            _ => {}
        }
        self.effects();
        Ok(())
    }

    /// What the journal says about the turn and controls measured here.
    fn tel_event(&mut self, e: &Event) {
        let at = Instant::now();
        self.tel.received(e.turn_id(), e.kind(), at);
        match e.kind() {
            "turn.steered" => self.tel.applied(Control::Steer, at),
            "ask.closed" => self.tel.applied(Control::Answer, at),
            k @ ("turn.completed" | "turn.failed" | "turn.cancelled") => {
                let cancelled = k == "turn.cancelled";
                if cancelled {
                    self.tel.applied(Control::Interrupt, at);
                    self.tel.applied(Control::Cancel, at);
                }
                if let Some(t) = e.turn_id() {
                    self.tel.turn_ended(t, cancelled);
                }
            }
            _ => {}
        }
    }

    fn flush_cache(&mut self) {
        if self.batch.is_empty() {
            return;
        }
        let batch = std::mem::take(&mut self.batch);
        if let Some(epoch) = self.log_epoch.filter(|_| self.pending_truncate.is_none()) {
            crate::cache::append_events(&self.m.session_id, epoch, &batch);
        }
    }

    /// The full plan goes into the transcript once, when it is asked.
    fn show_plans(&mut self) {
        let plans: Vec<(String, String)> = self.m.open_asks().filter(|a| is_plan(a) && !self.shown_plans.contains(&a.id)).map(|a| (a.id.clone(), plan_text(a))).collect();
        for (id, text) in plans {
            self.shown_plans.insert(id);
            if text.trim().is_empty() {
                continue;
            }
            self.m.print(TLine::row(2).s(format!("{} ", g().ask), Sty::Warn).s("Plan", Sty::Bold));
            let mut md = Md::new(TEXT_INDENT);
            md.push(&text);
            md.finish();
            for l in md.take() {
                self.m.print(l);
            }
        }
    }

    fn effects(&mut self) {
        for e in self.m.take_effects() {
            match e {
                Effect::Notify(t) => {
                    if let Some(seq) = self.notifier.sequence(&t, self.focused) {
                        let mut out = std::io::stdout();
                        let _ = out.write_all(seq.as_bytes());
                        let _ = out.flush();
                    }
                }
                Effect::Restore(t) => self.ed.restore(&t),
            }
        }
    }

    // ---- sending ------------------------------------------------------------

    fn idem(&self, what: &str) -> String {
        format!("{}:{what}", self.key_base)
    }

    fn can_send(&self) -> bool {
        self.m.conn == Conn::Online && matches!(self.create, CreateState::Exists)
    }

    fn send(&mut self, text: String, queue: bool) {
        if self.m.read_only {
            self.m.error("read-only: messages are not sent from this terminal");
            self.ed.restore(&text);
            return;
        }
        let idle = !self.m.turn_running() && self.m.queued.is_empty() && self.m.outgoing.is_empty();
        let out = self.m.send_local(&text, queue);
        if idle {
            self.tel.entered(out, Instant::now());
        } else if !queue && self.m.turn_running() {
            self.tel.control(Control::Steer, Some(out), Instant::now());
        }
        if let CreateState::Lazy(c) = &self.create {
            let c = c.clone();
            self.start_create(c, Some(out), Some(text));
            return;
        }
        if self.can_send() {
            self.send_now(out, queue);
        } else {
            self.unsent.push((out, queue));
            if let Some(w) = &self.wire
                && matches!(self.m.conn, Conn::Offline { .. })
            {
                w.probe();
            }
        }
    }

    fn send_now(&mut self, out: u64, queue: bool) {
        let Some(o) = self.m.outgoing.iter().find(|o| o.id == out) else { return };
        let Some(w) = self.wire.clone() else { return };
        let params = json!({
            "sessionId": self.m.session_id,
            "input": o.text,
            "ifBusy": if queue { "queue" } else { "steer" },
            "idempotencyKey": self.idem(&format!("send:{out}")),
        });
        self.futs.push(Box::pin(async move { Bg::Sent { out, result: w.call("turns.send", params).await } }));
    }

    fn flush_unsent(&mut self) {
        if !self.can_send() {
            return;
        }
        for (out, queue) in std::mem::take(&mut self.unsent) {
            if self.m.outgoing.iter().any(|o| o.id == out) {
                self.send_now(out, queue);
            }
        }
    }

    /// Creates the session: with the message, or without it, then the
    /// pushes, then the message. Retries while the network is down.
    fn start_create(&mut self, c: Create, out: Option<u64>, input: Option<String>) {
        self.create = CreateState::Creating(c.clone());
        if let Some(w) = &self.wire {
            w.attach(Attach { session_id: self.id(), after: Some(0), tail_turns: None, log_epoch: None });
        }
        let ctx = self.ctx;
        self.futs.push(Box::pin(async move {
            let mut body = c.body.clone();
            let push_first = !c.push.is_empty();
            if let (Some(t), false, Some(o)) = (&input, push_first, body.as_object_mut()) {
                o.insert("input".into(), Value::String(t.clone()));
            }
            let mut attempt = 0u32;
            let session = loop {
                match ctx.http.post("/sessions", &body, Some(&format!("{}:create", c.key))).await {
                    Ok(v) => break Ok(v),
                    Err(e) if e.retryable && attempt < 40 => {
                        attempt += 1;
                        tokio::time::sleep(crate::wire::reconnect::backoff(attempt).max(Duration::from_millis(500))).await;
                    }
                    Err(e) => break Err(e),
                }
            };
            let mut notes = Vec::new();
            let mut sent = None;
            if let Ok(v) = &session {
                let id = v.pointer("/session/id").and_then(Value::as_str).unwrap_or("").to_string();
                if push_first {
                    for (n, dir) in c.push.iter().enumerate() {
                        match crate::cmd::push::push_dir(ctx, &id, dir, None, Some(format!("{}:upload:{n}", c.key))).await {
                            Ok(r) => notes.push(push_line(dir, &r)),
                            Err(e) => notes.push(format!("{} push {}: {}", g().fail, dir.display(), e.message)),
                        }
                    }
                    if let Some(t) = &input {
                        let path = crate::http::session_path(&id, "/turns");
                        sent = Some(ctx.http.post(&path, &json!({"input": t}), Some(&format!("{}:send", c.key))).await);
                    }
                }
            }
            Bg::Created { out, session, sent, notes }
        }));
    }

    fn created(&mut self, out: Option<u64>, session: Result<Value>, sent: Option<Result<Value>>, notes: Vec<String>) {
        let now = now_ms();
        match session {
            Err(e) => {
                if let CreateState::Creating(c) = std::mem::replace(&mut self.create, CreateState::Exists) {
                    self.create = CreateState::Lazy(c);
                }
                match out {
                    Some(o) => {
                        self.tel.sent(o, Err(()));
                        self.m.sent(o, Err(&e), now)
                    }
                    None => self.m.error(&format!("the session was not created: {}", e.message)),
                }
            }
            Ok(v) => {
                self.create = CreateState::Exists;
                let real = v.pointer("/session/id").and_then(Value::as_str).unwrap_or("").to_string();
                if !real.is_empty() && real != self.m.session_id {
                    // The key had already created another session: that one.
                    let old = std::mem::replace(&mut self.m.session_id, real.clone());
                    self.tel.set_session(&real);
                    if let Some(w) = &self.wire {
                        w.detach(&old);
                        w.attach(Attach { session_id: real.clone(), after: Some(0), tail_turns: None, log_epoch: None });
                    }
                } else if self.reattach
                    && let Some(w) = &self.wire
                {
                    w.attach(Attach { session_id: self.id(), after: Some(0), tail_turns: None, log_epoch: None });
                }
                crate::cache::set_last_session(&self.id());
                for n in notes {
                    self.m.note(&n);
                }
                if let Some(o) = out {
                    let r = match &sent {
                        Some(r) => r.as_ref(),
                        None => Ok(&v),
                    };
                    self.tel.sent(o, r.map_err(|_| ()));
                    self.m.sent(o, r, now);
                }
                self.flush_unsent();
            }
        }
        self.effects();
    }

    fn interrupt(&mut self) {
        // Messages not sent yet come back to the prompt, connected or not.
        for p in self.m.take_pending() {
            self.ed.restore(&p.text);
        }
        let Some(w) = self.wire.clone() else { return };
        if self.m.read_only {
            self.m.error("read-only: cannot interrupt from this terminal");
            return;
        }
        let now = now_ms();
        if !self.m.turn_running() && self.m.queued.is_empty() {
            return;
        }
        self.m.interrupting(now);
        let mut params = json!({"sessionId": self.m.session_id, "idempotencyKey": self.idem(&format!("interrupt:{now}"))});
        if self.m.queued.is_empty()
            && let Some(t) = self.m.active_turn_id()
        {
            params["turnId"] = json!(t);
        }
        self.m.set_fact("interrupting…", now);
        let key = self.tel.control(Control::Interrupt, None, Instant::now());
        self.futs.push(Box::pin(async move {
            match w.call("sessions.interrupt", params).await {
                Ok(_) => Bg::Interrupted { key, fail: None },
                Err(e) => Bg::Interrupted { key, fail: Some(format!("interrupt failed: {}", e.message)) },
            }
        }));
    }

    fn call(&mut self, method: &'static str, mut params: Value, ok: Option<String>) {
        let Some(w) = self.wire.clone() else { return };
        params["sessionId"] = json!(self.m.session_id);
        self.futs.push(Box::pin(async move {
            match w.call(method, params).await {
                Ok(_) => ok.map(Bg::Note).unwrap_or(Bg::Quiet),
                Err(e) => Bg::Fail(e.message),
            }
        }));
    }

    // ---- results ------------------------------------------------------------

    fn bg(&mut self, b: Bg) {
        let now = now_ms();
        if let Bg::Answered { key, result, .. } | Bg::Unqueued { key, result, .. } = &b {
            self.tel.result(*key, result.is_ok());
        }
        match b {
            Bg::Created { out, session, sent, notes } => self.created(out, session, sent, notes),
            Bg::Sent { out, result } => {
                self.tel.sent(out, result.as_ref().map_err(|_| ()));
                self.m.sent(out, result.as_ref(), now);
                self.effects();
            }
            Bg::WireUrl(_) => {}
            Bg::Me(v) => {
                self.me = v.pointer("/person/id").and_then(Value::as_str).map(str::to_string);
                self.m.me = self.me.clone();
            }
            Bg::Answered { ask, always, result, .. } => match result {
                Ok(_) => {
                    if let Some(rule) = always {
                        self.m.print(TLine::new(2, 4).s(format!("{} ", g().ok), Sty::Ok).s(format!("allowed for this session: {rule}"), Sty::Plain));
                    }
                }
                Err(e) => {
                    self.answered.remove(&ask);
                    self.m.error(&format!("not answered: {}", e.message));
                }
            },
            Bg::Sessions(s) => {
                crate::cache::save_sessions(self.ctx.http.api_url(), &s);
                self.sessions = s;
                if let Some((ListKind::Sessions, l)) = &mut self.list {
                    l.refresh(session_items(&self.sessions, None));
                }
            }
            Bg::SubResult { name, result } => match result {
                Ok(v) => {
                    let sa = v.get("subagent").unwrap_or(&v);
                    let text = sa.get("result").and_then(Value::as_str).unwrap_or("").to_string();
                    self.print_result(&name, &text);
                }
                Err(e) => self.m.error(&format!("subagent \"{name}\": {}", e.message)),
            },
            Bg::Archived(r) => match r {
                Ok(_) => {
                    self.m.note("archived");
                    self.exit = Some(Exit::Detach);
                }
                Err(e) => self.m.error(&format!("not archived: {}", e.message)),
            },
            Bg::Note(t) => self.m.note(&t),
            Bg::Fail(t) => self.m.error(&t),
            Bg::Interrupted { key, fail } => {
                self.tel.result(key, fail.is_none());
                if let Some(t) = fail {
                    self.m.error(&t);
                }
            }
            Bg::Unqueued { text, result, .. } => match result {
                Ok(_) => {}
                Err(e) => {
                    self.m.error(&format!("it had already started: {}", e.message));
                    let _ = text;
                }
            },
            Bg::Quiet => {}
        }
    }

    fn print_result(&mut self, name: &str, text: &str) {
        self.m.print(TLine::row(2).s(format!("{} ", g().ok), Sty::Ok).s(format!("subagent \"{name}\""), Sty::Bold));
        if text.trim().is_empty() {
            self.m.note("no result");
            return;
        }
        let mut md = Md::new(TEXT_INDENT);
        md.push(text);
        md.finish();
        for l in md.take() {
            self.m.print(l);
        }
    }

    // ---- the keyboard -------------------------------------------------------

    async fn term_event(&mut self, ev: TermEvent) {
        match ev {
            TermEvent::Key(k) if matches!(k.kind, KeyEventKind::Press | KeyEventKind::Repeat) => {
                let now = now_ms();
                let guard = self.ask_focus && now - self.ask_focus_at < ASK_GUARD_MS;
                self.last_key = now;
                if guard {
                    match guarded(&k) {
                        Guarded::Swallow => return,
                        Guarded::ToPrompt => self.ask_focus = false,
                        Guarded::Pass => {}
                    }
                }
                self.key(k).await;
            }
            TermEvent::Paste(s) => {
                self.last_key = now_ms();
                self.ask_focus = false;
                self.ed.paste(&s);
            }
            TermEvent::FocusGained => self.focused = Some(true),
            TermEvent::FocusLost => self.focused = Some(false),
            TermEvent::Resize(w, h) => {
                self.size = ((w as usize).max(10), (h as usize).max(4));
                self.painter.resized(self.size.0);
            }
            _ => {}
        }
    }

    async fn key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let now = now_ms();
        // Keys that work everywhere.
        match k.code {
            KeyCode::Char('z') if ctrl => {
                let _ = self.painter.clear(&mut std::io::stdout());
                term::suspend_self();
                return;
            }
            KeyCode::Char('l') if ctrl => {
                let _ = self.painter.clear_screen(&mut std::io::stdout());
                return;
            }
            KeyCode::Char('t') if ctrl => {
                self.m.show_reasoning = !self.m.show_reasoning;
                let t = if self.m.show_reasoning { "reasoning shown" } else { "reasoning hidden" };
                self.m.set_fact(t, now);
                return;
            }
            KeyCode::Char('o') if ctrl && !(self.ask_focus && self.ask.is_some()) => {
                self.details(None);
                return;
            }
            _ => {}
        }
        if k.code != KeyCode::Char('c') || !ctrl {
            self.ctrl_c_at = None;
        }
        if !self.notice.is_empty() {
            self.notice.clear();
            if k.code == KeyCode::Esc {
                return;
            }
        }
        if self.list.is_some() {
            self.list_key(&k);
            return;
        }
        if self.ask_focus && self.ask.is_some() {
            if k.code == KeyCode::Tab {
                self.ask_focus = false;
                return;
            }
            if self.m.read_only {
                self.m.set_fact("read-only: asks are answered elsewhere", now);
                self.ask_focus = false;
                return;
            }
            let out = self.ask.as_mut().map(|a| a.key(&k)).unwrap_or(AskOut::None);
            self.ask_out(out);
            return;
        }
        self.prompt_key(k).await;
    }

    async fn prompt_key(&mut self, k: KeyEvent) {
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        let now = now_ms();
        let empty = self.ed.is_empty();
        match k.code {
            KeyCode::Esc if !self.ed.searching() => {
                self.interrupt();
                return;
            }
            KeyCode::Char('c') if ctrl => {
                if !empty {
                    // ↑ brings it back.
                    self.ed.remember(&self.ed.expanded());
                    self.ed.clear();
                } else if self.m.turn_running() || !self.m.queued.is_empty() {
                    self.interrupt();
                } else if self.ctrl_c_at.is_some_and(|t| now - t < CTRL_C_MS) {
                    self.exit = Some(Exit::Detach);
                } else {
                    self.ctrl_c_at = Some(now);
                    self.m.set_fact_for("press Ctrl+C again to detach", now + CTRL_C_MS);
                }
                return;
            }
            KeyCode::Char('d') if ctrl && empty => {
                self.exit = Some(Exit::Detach);
                return;
            }
            KeyCode::Tab => {
                let line = self.ed.text();
                if line.starts_with('/') {
                    match slash::complete(&line) {
                        Ok(s) => self.ed.set(&s),
                        Err(c) if !c.is_empty() => self.m.set_fact(c.join("  "), now),
                        Err(_) => {}
                    }
                } else if self.ask.is_some() {
                    self.ask_focus = true;
                    self.ask_focus_at = 0;
                } else {
                    // A paste without bracketed paste keeps its tabs.
                    self.ed.insert("\t");
                }
                return;
            }
            KeyCode::Up if empty && self.m.queued.iter().any(|q| q.who.is_none()) => {
                if let Some(q) = self.m.take_last_queued() {
                    self.ed.set(&q.text);
                    let path = crate::http::session_path(&self.m.session_id, &format!("/turns/{}/cancel", crate::net::encode(&q.turn_id)));
                    let http = self.ctx.http.clone();
                    let text = q.text.clone();
                    let key = self.tel.control(Control::Cancel, None, Instant::now());
                    self.futs.push(Box::pin(async move { Bg::Unqueued { text, key, result: http.post(&path, &json!({}), None).await } }));
                }
                return;
            }
            KeyCode::Char('?') if empty && !ctrl => {
                self.notice = keys_table();
                return;
            }
            _ => {}
        }
        let was_x = self.ed.pending_ctrl_x();
        if Editor::wants_editor(&k, was_x) {
            let _ = self.painter.clear(&mut std::io::stdout());
            let _ = self.ed.key(&k);
            match details::edit(&self.ed.text()) {
                Ok(t) => self.ed.set(&t),
                Err(e) => self.m.error(&format!("editor: {e}")),
            }
            return;
        }
        match self.ed.key(&k) {
            Edit::Submit(text) => self.submit(text).await,
            Edit::Done | Edit::Ignored => {}
        }
    }

    async fn submit(&mut self, text: String) {
        if text.trim().is_empty() {
            return;
        }
        self.ed.remember(&text);
        crate::cache::add_history(&text);
        self.ed.clear();
        if let Some(w) = &self.wire
            && matches!(self.m.conn, Conn::Offline { .. })
        {
            w.probe();
        }
        match slash::parse(&text) {
            Line::Message(t) => self.send(t, false),
            Line::Command(c) => self.command(c).await,
            Line::Unknown(msg) => {
                self.m.note(&msg);
                self.ed.set(&text);
            }
        }
    }

    fn ask_out(&mut self, out: AskOut) {
        let Some(a) = &self.ask else { return };
        let ask_id = a.id().to_string();
        let now = now_ms();
        match out {
            AskOut::None => {}
            AskOut::ToPrompt => self.ask_focus = false,
            AskOut::Details => {
                let text = details::render(&self.m.events, &[], std::slice::from_ref(&a.ask), None);
                let _ = self.painter.clear(&mut std::io::stdout());
                if let Err(e) = details::page(&text) {
                    self.m.error(&format!("pager: {e}"));
                }
            }
            AskOut::Answer(body) => {
                let always = if body.get("decision").and_then(Value::as_str) == Some("always") { a.ask.approval.as_ref().and_then(|x| x.always_allows.clone()) } else { None };
                // The schema's `asks.answer` takes the answer whole, as `answer`.
                let params = json!({"sessionId": self.m.session_id, "askId": ask_id, "answer": body});
                self.answered.insert(ask_id.clone());
                self.ask_focus = false;
                let Some(w) = self.wire.clone() else { return };
                let key = self.tel.control(Control::Answer, None, Instant::now());
                self.futs.push(Box::pin(async move { Bg::Answered { ask: ask_id, always, key, result: w.call("asks.answer", params).await } }));
            }
            AskOut::Dismiss => {
                self.answered.insert(ask_id.clone());
                self.ask_focus = false;
                let params = json!({"sessionId": self.m.session_id, "askId": ask_id});
                let Some(w) = self.wire.clone() else { return };
                let key = self.tel.control(Control::Answer, None, Instant::now());
                self.futs.push(Box::pin(async move { Bg::Answered { ask: ask_id, always: None, key, result: w.call("asks.dismiss", params).await } }));
            }
            AskOut::Web => {
                let url = self.ctx.url_for(None, &self.m.session_id);
                open_url(&url);
                self.m.set_fact(format!("opened {url}"), now);
                self.ask_focus = false;
            }
        }
    }

    fn details(&mut self, only: Option<&str>) {
        let subs: Vec<_> = self.m.subs.iter().map(|s| s.sa.clone()).collect();
        let asks: Vec<_> = self.m.open_asks().cloned().collect();
        let text = details::render(&self.m.events, &subs, &asks, only);
        let _ = self.painter.clear(&mut std::io::stdout());
        if let Err(e) = details::page(&text) {
            self.m.error(&format!("pager: {e}"));
        }
    }

    // ---- lists ----------------------------------------------------------------

    fn list_key(&mut self, k: &KeyEvent) {
        let Some((kind, list)) = &mut self.list else { return };
        let kind = *kind;
        let pick = list.key(k);
        match pick {
            Pick::None => {}
            Pick::Close => self.list = None,
            Pick::Chosen(key) => self.chosen(kind, key),
            Pick::Key(c, key) => self.list_letter(kind, c, key),
        }
    }

    fn chosen(&mut self, kind: ListKind, key: String) {
        match kind {
            ListKind::Sessions => {
                self.list = None;
                if key != self.m.session_id {
                    self.exit = Some(Exit::Attach(key));
                }
            }
            ListKind::Model | ListKind::Effort | ListKind::Speed | ListKind::Mode => {
                self.list = None;
                let field = match kind {
                    ListKind::Model => "model",
                    ListKind::Effort => "effort",
                    ListKind::Speed => "speed",
                    _ => "mode",
                };
                self.update(field, json!(key));
            }
            ListKind::Subagents => self.open_subagent(&key),
        }
    }

    fn list_letter(&mut self, kind: ListKind, c: char, key: String) {
        if kind != ListKind::Subagents {
            return;
        }
        match c {
            'x' => {
                let Some(sub) = self.m.subs.iter().find(|s| s.sa.id == key) else { return };
                if !sub.sa.is_running() {
                    self.m.set_fact("it has already ended", now_ms());
                    return;
                }
                let q = format!("stop \"{}\"? y/n", sub.sa.name);
                if let Some((_, l)) = &mut self.list {
                    l.confirm = Some(q);
                }
            }
            'y' => {
                if self.m.read_only {
                    self.m.error("read-only: cannot stop a subagent from this terminal");
                    return;
                }
                let name = self.m.subs.iter().find(|s| s.sa.id == key).map(|s| s.sa.name.clone()).unwrap_or_default();
                self.call("subagents.stop", json!({"subagentId": key}), Some(format!("stopping \"{name}\"")));
            }
            _ => {}
        }
    }

    fn open_subagent(&mut self, key: &str) {
        let Some(sub) = self.m.subs.iter().find(|s| s.sa.id == key) else { return };
        let name = sub.sa.name.clone();
        if sub.sa.is_running() {
            let k = key.to_string();
            self.details(Some(&k));
            return;
        }
        if let Some(r) = sub.sa.result.clone().filter(|_| sub.sa.result_truncated != Some(true)) {
            self.list = None;
            self.print_result(&name, &r);
            return;
        }
        self.list = None;
        let path = crate::http::session_path(&self.m.session_id, &format!("/subagents/{}", crate::net::encode(key)));
        let http = self.ctx.http.clone();
        self.futs.push(Box::pin(async move { Bg::SubResult { name, result: http.get(&path, &[]).await } }));
    }

    fn subagent_items(&self, now: i64) -> Vec<Item> {
        let mut subs: Vec<_> = self.m.subs.iter().collect();
        subs.sort_by_key(|s| (!s.sa.is_running(), -s.start));
        subs.iter()
            .map(|s| {
                let (glyph, sty) = match s.sa.status.as_str() {
                    "running" => (super::spinner(now), Sty::Accent),
                    "completed" => (g().ok, Sty::Ok),
                    _ => (g().fail, Sty::Err),
                };
                let mut segs = vec![Seg::new(format!("{glyph} "), sty)];
                segs.extend(self.m.subagent_segs(s, now, !s.sa.is_running()));
                if s.sa.tokens > 0 {
                    segs.push(Seg::new(format!(" {} {} tokens", g().mid, super::tokens(s.sa.tokens)), Sty::Dim));
                }
                Item::segs(s.sa.id.clone(), segs)
            })
            .collect()
    }

    fn update(&mut self, field: &str, value: Value) {
        if self.m.read_only {
            self.m.error("read-only: settings are not changed from this terminal");
            return;
        }
        let mut p = Map::new();
        p.insert(field.to_string(), value);
        self.call("sessions.update", Value::Object(p), None);
    }

    fn setting_values(&self, kind: ListKind) -> Vec<(String, String)> {
        if kind == ListKind::Speed {
            // A closed list, not one of the capabilities.
            return SPEEDS.iter().map(|s| (s.to_string(), s.to_string())).collect();
        }
        let Some(caps) = &self.m.caps else { return Vec::new() };
        match kind {
            ListKind::Model => caps.models.iter().map(|m| (m.id.clone(), m.name.clone().unwrap_or_else(|| m.id.clone()))).collect(),
            ListKind::Effort => {
                let cur = self.m.settings.model.clone().unwrap_or_default();
                let model = caps.models.iter().find(|m| m.id == cur).or_else(|| caps.models.iter().find(|m| m.default));
                let mut v: Vec<String> = match model {
                    Some(m) => m.efforts.clone(),
                    None => caps.models.iter().flat_map(|m| m.efforts.clone()).collect(),
                };
                v.dedup();
                v.into_iter().map(|e| (e.clone(), e)).collect()
            }
            _ => caps
                .modes
                .iter()
                .map(|m| (m.clone(), crate::ui::model::mode_choice(m)))
                .collect(),
        }
    }

    fn setting(&mut self, kind: ListKind, typed: Option<String>) {
        let (field, current) = match kind {
            ListKind::Model => ("model", self.m.settings.model.clone()),
            ListKind::Effort => ("effort", self.m.settings.effort.clone()),
            // Not set means the default, fast.
            ListKind::Speed => ("speed", Some(self.m.settings.speed.clone().unwrap_or_else(|| "fast".into()))),
            _ => ("mode", self.m.settings.mode.clone()),
        };
        let values = self.setting_values(kind);
        match typed {
            Some(t) => {
                if values.is_empty() {
                    // Not known yet: the server checks it.
                    self.update(field, json!(t));
                    return;
                }
                match slash::match_value(&t, &values) {
                    Ok(id) => {
                        let id = id.to_string();
                        self.update(field, json!(id));
                    }
                    Err(e) => self.m.error(&format!("{field}: {e}")),
                }
            }
            None => {
                if values.is_empty() {
                    let cur = if kind == ListKind::Model { self.m.model_name() } else { current.unwrap_or_default() };
                    self.m.note(&format!("{field}: {}", if cur.is_empty() { "not known yet" } else { &cur }));
                    return;
                }
                let items = values
                    .iter()
                    .map(|(id, name)| {
                        let mut it = Item::new(id.clone(), name.clone());
                        it.current = current.as_deref() == Some(id.as_str());
                        it
                    })
                    .collect();
                self.list = Some((kind, List::new(field, items, false)));
            }
        }
    }

    // ---- slash commands -------------------------------------------------------

    async fn command(&mut self, c: Cmd) {
        let now = now_ms();
        let id = self.id();
        match c {
            Cmd::Help => {
                for (name, what) in slash::COMMANDS {
                    self.m.print(TLine::row(2).s(format!("{name:<12}"), Sty::Accent).s(*what, Sty::Dim));
                }
            }
            Cmd::Model(t) => self.setting(ListKind::Model, t),
            Cmd::Effort(t) => self.setting(ListKind::Effort, t),
            Cmd::Speed(t) => self.setting(ListKind::Speed, t),
            Cmd::Mode(t) => self.setting(ListKind::Mode, t),
            Cmd::Title(t) => {
                if t.trim().is_empty() {
                    self.m.error("/title needs the new title");
                } else {
                    self.update("title", json!(t.trim()));
                }
            }
            Cmd::Queue(t) => {
                if t.trim().is_empty() {
                    self.m.error("/queue needs a message");
                } else {
                    self.send(t, true);
                }
            }
            Cmd::Interrupt => self.interrupt(),
            Cmd::Compact(instr) => {
                if self.m.read_only {
                    self.m.error("read-only: cannot compact from this terminal");
                    return;
                }
                let mut p = json!({"idempotencyKey": self.idem(&format!("compact:{now}"))});
                if let Some(i) = instr {
                    p["instructions"] = json!(i);
                }
                let when = if self.m.turn_running() { "compacting after the running turn" } else { "compacting" };
                self.m.note(when);
                self.call("sessions.compact", p, None);
            }
            Cmd::Allowed => self.m.note("/allowed is not available yet: the API has no route for a session's allowed rules"),
            Cmd::Diff { stat } => {
                // `opc diff`: the workspace's git diff, through $PAGER.
                let a = crate::cli::DiffArgs { id: None, session: crate::cli::SessionOpt { session: Some(id) }, stat };
                self.hand_over_async(|ctx| Box::pin(async move { crate::cmd::manage::diff(ctx, a).await.map(|_| ()) })).await;
            }
            Cmd::Push { dir, to } => {
                if self.m.read_only {
                    self.m.error("read-only: cannot push from this terminal");
                    return;
                }
                let p = dir.strip_prefix("~/").and_then(|r| dirs::home_dir().map(|h| h.join(r))).unwrap_or_else(|| PathBuf::from(&dir));
                let ctx = self.ctx;
                let key = self.idem(&format!("upload:{now}"));
                self.m.set_fact(format!("{} pushing {dir}…", g().up), now);
                self.futs.push(Box::pin(async move {
                    match crate::cmd::push::push_dir(ctx, &id, &p, to.as_deref(), Some(key)).await {
                        Ok(r) => Bg::Note(push_line(&p, &r)),
                        Err(e) => Bg::Fail(format!("push {}: {}", p.display(), e.message)),
                    }
                }));
            }
            Cmd::Pull { path, dir } => {
                let a = crate::cli::PullArgs {
                    path,
                    dir: dir.map(PathBuf::from),
                    session: crate::cli::SessionOpt { session: Some(id) },
                    force: false,
                    dry_run: false,
                    json: false,
                };
                self.hand_over_async(|ctx| Box::pin(async move { crate::cmd::pull::run(ctx, a).await.map(|_| ()) })).await;
            }
            Cmd::Shell => {
                self.hand_over_async(|ctx| Box::pin(async move { crate::cmd::shell::interactive(ctx, &id).await.map(|_| ()) })).await;
            }
            Cmd::Sessions => {
                let cached = crate::cache::sessions(self.ctx.http.api_url());
                let items = session_items(if self.sessions.is_empty() { &cached } else { &self.sessions }, None);
                self.list = Some((ListKind::Sessions, List::new("sessions", items, true)));
                let ctx = self.ctx;
                self.futs.push(Box::pin(async move {
                    match crate::cmd::resolve::list(ctx, &[("owner", "me"), ("order", "active"), ("limit", "50")], None).await {
                        Ok((s, _)) => Bg::Sessions(s),
                        Err(e) => Bg::Fail(format!("sessions: {}", e.message)),
                    }
                }));
            }
            Cmd::New => self.exit = Some(Exit::New),
            Cmd::Detach => self.exit = Some(Exit::Detach),
            Cmd::Suspend => {
                if self.m.read_only {
                    self.m.error("read-only: cannot suspend from this terminal");
                    return;
                }
                self.call("sessions.suspend", json!({"idempotencyKey": self.idem(&format!("suspend:{now}"))}), Some("suspended".into()));
            }
            Cmd::Archive => {
                if self.m.read_only {
                    self.m.error("read-only: cannot archive from this terminal");
                    return;
                }
                let Some(w) = self.wire.clone() else { return };
                let p = json!({"sessionId": id, "archived": true});
                self.futs.push(Box::pin(async move { Bg::Archived(w.call("sessions.update", p).await) }));
            }
            Cmd::Web => {
                let url = self.ctx.url_for(None, &id);
                open_url(&url);
                self.m.set_fact(format!("opened {url}"), now);
            }
            Cmd::Copy { code } => {
                let what = if code { self.m.last_code.clone() } else { self.m.last_text.clone() };
                match what {
                    Some(t) => {
                        let mut out = std::io::stdout();
                        let _ = out.write_all(super::notify::copy(&t, env).as_bytes());
                        let _ = out.flush();
                        let lines = t.lines().count().max(1);
                        self.m.set_fact(format!("copied {}", plural(lines, "line")), now);
                    }
                    None => self.m.set_fact(if code { "no code block yet" } else { "nothing to copy yet" }, now),
                }
            }
            Cmd::Details => self.details(None),
            Cmd::Subagents(n) => {
                let items = self.subagent_items(now);
                if items.is_empty() {
                    self.m.note("no subagents in this session yet");
                    return;
                }
                let mut l = List::new("subagents", items, false);
                l.hint = "enter result · x stop · esc close".into();
                if let Some(n) = n {
                    match l.items.get(n.saturating_sub(1)).map(|i| i.key.clone()) {
                        Some(k) => {
                            l.sel = n.saturating_sub(1);
                            self.list = Some((ListKind::Subagents, l));
                            self.open_subagent(&k);
                        }
                        None => self.m.error(&format!("there is no subagent {n}")),
                    }
                    return;
                }
                self.list = Some((ListKind::Subagents, l));
            }
            Cmd::Timing => {
                let t = &self.timing;
                let ms = |d: Option<Duration>| d.map(|d| format!("{} ms", d.as_millis())).unwrap_or_else(|| "–".into());
                self.m.note(&format!("first frame {} {} connected in {} {} attached at {}", ms(t.first_frame), g().mid, ms(t.connected), g().mid, ms(t.attached)));
            }
            Cmd::Id => {
                self.m.print(TLine::row(2).s(id.clone(), Sty::Bold));
                let url = self.ctx.url_for(None, &id);
                let mut l = TLine::row(2).s("", Sty::Plain);
                l.segs.push(Seg { text: url.clone(), sty: Sty::Link, link: Some(url) });
                self.m.print(l);
            }
        }
    }

    /// Gives the terminal to an async command (`/shell`, `/pull`) and takes
    /// it back.
    async fn hand_over_async<F>(&mut self, f: F)
    where
        F: FnOnce(&'a Ctx) -> Pin<Box<dyn Future<Output = Result<()>> + 'a>>,
    {
        let _ = self.painter.clear(&mut std::io::stdout());
        term::restore();
        let r = f(self.ctx).await;
        term::resume();
        if let Err(e) = r {
            self.m.error(&e.message);
        }
    }

    // ---- drawing --------------------------------------------------------------

    /// Keeps the ask widget on the first open ask, and gives it the
    /// keyboard when the person is not typing.
    fn sync_ask(&mut self, now: i64) {
        let open = self.m.open_asks().find(|a| !self.answered.contains(&a.id)).cloned();
        match (open, &self.ask) {
            (None, _) => {
                self.ask = None;
                self.ask_focus = false;
            }
            (Some(a), Some(cur)) if cur.id() == a.id => {}
            (Some(a), _) => {
                self.ask = Some(AskUi::new(a));
                self.ask_focus = false;
                self.ask_auto_done = false;
            }
        }
        if self.ask.is_some() && !self.ask_focus && !self.ask_auto_done && !self.m.read_only && self.list.is_none() && self.ed.is_empty() && now - self.last_key >= ASK_IDLE_MS {
            self.ask_focus = true;
            self.ask_focus_at = now;
            self.ask_auto_done = true;
        }
    }

    fn draw(&mut self, force: bool) {
        let now = now_ms();
        self.m.tick(now);
        self.effects();
        self.sync_ask(now);
        let busy = self.m.turn_running() || self.m.conn != Conn::Online || self.m.running_subagents() > 0;
        let every = if busy { 80 } else { 500 };
        if !force && !self.dirty && now - self.last_draw < every && !self.m.has_out() {
            return;
        }
        self.dirty = false;
        self.last_draw = now;
        let (w, h) = self.size;
        let settled = self.m.take_out();
        let live = self.live(now, w);
        let (rows, cursor) = view::compose(&live, w, h);
        let mut out = std::io::stdout();
        let t0 = Instant::now();
        let r = self.painter.frame(&mut out, &settled, &rows, cursor, w);
        let t1 = Instant::now();
        if r.is_err() && !self.render_failed {
            // Once: a broken terminal fails every frame after.
            self.render_failed = true;
            telemetry::error(telemetry::ErrorClass::Render, None);
        }
        self.tel.drawn(t1, t1 - t0);
        telemetry::rendered(t1);
        let t = self.m.term_title();
        if t != self.title_shown {
            term::title(&t);
            self.title_shown = t;
        }
    }

    fn live(&mut self, now: i64, w: usize) -> Live {
        let (top, pinned) = self.m.live(now);
        let mut live = Live { top, pinned, ..Live::default() };
        if let Some(a) = &self.ask {
            if self.ask_focus {
                let (lines, cur) = a.render(w, true);
                live.ask = lines;
                live.ask_cursor = cur;
                live.ask_focused = true;
            } else {
                let (lines, _) = a.render(w, false);
                live.ask = lines.into_iter().take(1).collect();
                live.ask.push(TLine::row(4).s(format!("{} ask open {} Tab to answer", g().ask, g().mid), Sty::Warn));
            }
        }
        if let Some((ListKind::Subagents, _)) = &self.list {
            let items = self.subagent_items(now);
            if let Some((_, l)) = &mut self.list {
                l.refresh(items);
            }
        }
        if let Some((_, l)) = &self.list {
            live.list = l.render(w);
        } else if !self.notice.is_empty() {
            live.list = self.notice.clone();
        }
        let placeholder = if self.m.read_only {
            "read-only"
        } else if self.ask.is_some() && !self.ask_focus {
            "a message declines the ask · /queue sends it after"
        } else if self.m.turn_running() {
            "steer the agent · /queue for after this turn"
        } else {
            "type a message · ? for keys"
        };
        let (prompt, pc) = self.ed.render(w, placeholder);
        live.prompt = prompt;
        live.prompt_cursor = pc;
        let (left, right) = self.m.status(now);
        live.status_left = left;
        live.status_right = right;
        live
    }

    /// Leaves the screen: the live area is erased and where we were is
    /// printed, with anything typed and not sent.
    fn finish(&mut self, err: Option<&Error>) {
        let (w, _) = self.size;
        let mut lines = self.m.take_out();
        if err.is_none() {
            let title = if self.m.title.trim().is_empty() { crate::ids::short(&self.m.session_id).to_string() } else { truncate(&self.m.title, 60) };
            lines.push(TLine::row(0).s(format!("[detached from \"{title}\" {} {} {} opc a - to return]", g().mid, self.m.state_word(), g().mid), Sty::Dim));
        }
        let mut unsent: Vec<String> = self.m.outgoing.iter().filter(|o| !matches!(o.state, super::model::OutState::Steered { .. })).map(|o| o.text.clone()).collect();
        let typed = self.ed.text();
        if !typed.trim().is_empty() {
            unsent.push(typed);
        }
        for t in unsent {
            lines.push(TLine::row(0).s("not sent:", Sty::Warn));
            for l in t.lines() {
                lines.push(TLine::row(2).s(l.to_string(), Sty::Plain));
            }
        }
        self.flush_cache();
        let _ = self.painter.finish(&mut std::io::stdout(), &lines, w);
        self.tel.leave();
        if let Some(w) = &self.wire {
            w.close();
        }
    }
}

/// What a key does while an ask that just took the keyboard is guarded.
#[derive(Debug, PartialEq, Eq)]
enum Guarded {
    /// Would answer the ask: dropped.
    Swallow,
    /// Typing: back to the prompt, where it lands.
    ToPrompt,
    Pass,
}

fn guarded(k: &KeyEvent) -> Guarded {
    if k.modifiers.intersects(KeyModifiers::CONTROL | KeyModifiers::ALT) {
        return Guarded::Pass;
    }
    match k.code {
        KeyCode::Enter | KeyCode::Char('y' | 'n' | 'a' | 'A') => Guarded::Swallow,
        KeyCode::Char(_) => Guarded::ToPrompt,
        _ => Guarded::Pass,
    }
}

/// `↑ billing → workspace/billing · 412 files · 3.1 MB`, from what the push
/// returned.
fn push_line(dir: &std::path::Path, r: &Value) -> String {
    let name = dir.file_name().map(|n| n.to_string_lossy().to_string()).unwrap_or_else(|| dir.display().to_string());
    let to = r.get("path").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| format!("workspace/{name}"));
    let mut s = format!("{} {name} {} {to}", g().up, g().arrow);
    if let Some(f) = r.get("files").and_then(Value::as_u64) {
        s.push_str(&format!(" {} {}", g().mid, plural(f as usize, "file")));
    }
    if let Some(b) = r.get("bytes").and_then(Value::as_u64) {
        s.push_str(&format!(" {} {}", g().mid, bytes(b)));
    }
    s
}

fn bytes(b: u64) -> String {
    match b {
        b if b >= 1 << 30 => format!("{:.1} GB", b as f64 / (1u64 << 30) as f64),
        b if b >= 1 << 20 => format!("{:.1} MB", b as f64 / (1u64 << 20) as f64),
        b if b >= 1 << 10 => format!("{:.0} KB", b as f64 / 1024.0),
        b => format!("{b} B"),
    }
}

/// Opens a link in the browser, quietly.
fn open_url(url: &str) {
    if !(url.starts_with("https://") || url.starts_with("http://")) {
        return;
    }
    let cmd = if cfg!(target_os = "macos") { "open" } else { "xdg-open" };
    let _ = std::process::Command::new(cmd).arg(url).stdin(std::process::Stdio::null()).stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null()).spawn();
}

/// The keys table for `?`.
fn keys_table() -> Vec<TLine> {
    let rows = [
        ("enter", "send · steers a running turn"),
        ("/queue", "send after the running turn"),
        ("esc", "interrupt · close a list"),
        ("ctrl+c", "clear · interrupt · twice to detach"),
        ("ctrl+d", "detach"),
        ("tab", "to the ask and back · complete"),
        ("ctrl+o", "details in $PAGER"),
        ("ctrl+t", "show reasoning"),
        ("ctrl+r", "search history"),
        ("ctrl+x ctrl+e", "edit in $EDITOR"),
    ];
    let mut v = vec![TLine::row(2).s("keys", Sty::Bold)];
    for (k, d) in rows {
        v.push(TLine::row(4).s(format!("{k:<15}"), Sty::Accent).s(d, Sty::Dim));
    }
    v
}

/// Picker rows: the title, then the state and the last line, dimmed.
pub fn session_items(sessions: &[Session], only: Option<&[String]>) -> Vec<Item> {
    sessions
        .iter()
        .filter(|s| only.is_none_or(|o| o.contains(&s.id)))
        .map(|s| {
            let title = if s.title.trim().is_empty() { "Untitled".to_string() } else { super::clean(&s.title) };
            let mut segs = vec![Seg::new(title, Sty::Plain), Seg::new(format!("  {} {} {}", crate::ids::short(&s.id), g().mid, s.status), Sty::Dim)];
            if let Some(t) = s.last_text.as_deref().filter(|t| !t.trim().is_empty()) {
                segs.push(Seg::new(format!(" {} {}", g().mid, first_line(&super::clean(t))), Sty::Dim));
            }
            Item::segs(s.id.clone(), segs)
        })
        .collect()
}

/// `opc a` without a session, or with words that match several: a list
/// under the prompt line. Returns the chosen id.
pub async fn pick(ctx: &Ctx, only: Option<Vec<String>>) -> Result<Option<String>> {
    let guard = term::enter().map_err(|e| Error::usage(format!("cannot use the terminal: {e}")))?;
    let mut painter = Painter::new(ctx.color);
    let cached = crate::cache::sessions(ctx.http.api_url());
    let mut list = List::new(if only.is_some() { "sessions that match" } else { "sessions" }, session_items(&cached, only.as_deref()), true);
    list.max_rows = 8;
    let mut keys = EventStream::new();
    let mut fetch: FuturesUnordered<Fetch<'_>> = FuturesUnordered::new();
    fetch.push(Box::pin(async move {
        let (s, _) = crate::cmd::resolve::list(ctx, &[("owner", "me"), ("order", "active"), ("limit", "50")], None).await?;
        Ok(s)
    }));
    let mut fact = String::from("loading…");
    let mut extra: Vec<Session> = Vec::new();
    let mut stop = std::pin::pin!(term::stop_signal());
    let mut killed = None;
    let result = loop {
        let (w, h) = size();
        let lines = list.render(w);
        let live = Live { list: lines, status_left: vec![Seg::new(fact.clone(), Sty::Dim)], status_right: String::new(), ..Live::default() };
        let (mut rows, _) = view::compose(&live, w, h);
        // No prompt line here: drop the rule and the empty prompt.
        let n = rows.len();
        if n >= 3 {
            rows.drain(n - 3..n - 1);
        }
        let cursor = (rows.len().saturating_sub(1), 0);
        let _ = painter.frame(&mut std::io::stdout(), &[], &rows, cursor, w);
        tokio::select! {
            Some(r) = fetch.next(), if !fetch.is_empty() => match r {
                Ok(s) => {
                    crate::cache::save_sessions(ctx.http.api_url(), &s);
                    // Matches not in the first page still show.
                    let mut all = s;
                    if let Some(o) = &only {
                        for c in &cached {
                            if o.contains(&c.id) && !all.iter().any(|x| x.id == c.id) {
                                all.push(c.clone());
                            }
                        }
                        for id in o {
                            if !all.iter().any(|x| &x.id == id) {
                                all.push(Session { id: id.clone(), ..Session::default() });
                            }
                        }
                    }
                    extra = all;
                    list.refresh(session_items(&extra, only.as_deref()));
                    fact.clear();
                }
                Err(e) => fact = format!("{} {}", g().fail, e.message),
            },
            code = &mut stop => {
                killed = Some(code);
                break None;
            }
            k = keys.next() => match k {
                None => break None,
                Some(Ok(TermEvent::Key(k))) if matches!(k.kind, KeyEventKind::Press | KeyEventKind::Repeat) => match list.key(&k) {
                    Pick::Close => break None,
                    Pick::Chosen(id) => break Some(id),
                    _ => {}
                },
                _ => {}
            },
        }
    };
    let _ = extra;
    let _ = painter.finish(&mut std::io::stdout(), &[], 80);
    drop(guard);
    if let Some(code) = killed {
        std::process::exit(code);
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn push_lines_read_the_result() {
        let r = json!({"path": "workspace/billing", "files": 412, "bytes": 3_250_000});
        assert_eq!(push_line(std::path::Path::new("/src/billing"), &r), format!("{} billing {} workspace/billing {} 412 files {} 3.1 MB", g().up, g().arrow, g().mid, g().mid));
        assert_eq!(push_line(std::path::Path::new("x"), &json!({})), format!("{} x {} workspace/x", g().up, g().arrow));
    }

    #[test]
    fn the_ask_guard_drops_answers_and_lets_typing_through() {
        let key = |c| KeyEvent::new(c, KeyModifiers::NONE);
        assert_eq!(guarded(&key(KeyCode::Char('y'))), Guarded::Swallow);
        assert_eq!(guarded(&key(KeyCode::Enter)), Guarded::Swallow);
        assert_eq!(guarded(&key(KeyCode::Char('u'))), Guarded::ToPrompt);
        assert_eq!(guarded(&key(KeyCode::Char('1'))), Guarded::ToPrompt);
        assert_eq!(guarded(&key(KeyCode::Esc)), Guarded::Pass);
        assert_eq!(guarded(&KeyEvent::new(KeyCode::Char('c'), KeyModifiers::CONTROL)), Guarded::Pass);
    }

    #[test]
    fn picker_rows_filter_to_matches() {
        let s = vec![
            Session { id: "cs_aaaaaaaaaaaaaaaa".into(), title: "flaky test".into(), status: "idle".into(), ..Session::default() },
            Session { id: "cs_bbbbbbbbbbbbbbbb".into(), title: "".into(), status: "running".into(), last_text: Some("done\nmore".into()), ..Session::default() },
        ];
        assert_eq!(session_items(&s, None).len(), 2);
        let only = vec!["cs_bbbbbbbbbbbbbbbb".to_string()];
        let it = session_items(&s, Some(&only));
        assert_eq!(it.len(), 1);
        assert!(it[0].search.contains("untitled") && it[0].search.contains("done") && !it[0].search.contains("more"));
    }
}
