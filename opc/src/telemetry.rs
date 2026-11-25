//! Usage telemetry: how fast opc feels, sent to your own computer.
//!
//! What it records (the `cli.*` events), one event per real occurrence,
//! never a rollup:
//! - `cli.turn`: a turn you started with Enter: Enter → its first event,
//!   → its first output received, → that output drawn;
//! - `cli.attach`: each attach of a session: socket open → drawn, the
//!   connect time, and for a reconnect the gap;
//! - `cli.control`: each steer, interrupt, answer or cancel: key → the
//!   server's answer drawn, and → the journal showing it applied;
//! - `cli.render`: a draw that showed events which waited 100 ms or more;
//! - `cli.connection`: each wire connection that ended: how long it was up,
//!   frames and bytes received, the close code;
//! - `cli.error`: each error, by a closed class;
//! - `cli.overflow`: events dropped because the small send buffer was full.
//!
//! Never content: no messages, no output, no paths, no commands, no keys.
//! Ids only (`cs_…` sessions, turn ids). Every frame carries opc's version,
//! OS and CPU architecture from closed lists.
//!
//! How it is sent: as a `telemetry` JSON-RPC notification on the WebSocket
//! opc already has open, about a second after an event, a few events per
//! frame, within the server's rate limit (a burst of 3 frames, then 6 a
//! minute). Never over a connection of its own, never to an analytics
//! service, never over HTTP-only use. The server checks each event against a
//! closed table of names and fields. All aggregation (percentiles, sums)
//! happens downstream.
//!
//! Hot path: recording an event is a mutex-guarded push onto a bounded queue
//! (and a wake of the wire task); nothing here does I/O except reading the
//! setting once and the crash marker.
//!
//! Off with `OPC_TELEMETRY=0` (or `DO_NOT_TRACK=1`), or `opc config
//! telemetry off`; `docs/reference/telemetry.mdx` lists every field.

use serde_json::{Map, Value, json};
use std::collections::VecDeque;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

/// Events per frame, bytes per frame (the server drops a frame over either).
pub const MAX_EVENTS: usize = 20;
pub const MAX_FRAME_BYTES: usize = 16 * 1024;
/// How long an event waits for others to share its frame.
pub const BATCH_WAIT: Duration = Duration::from_secs(1);
/// Frames an exiting opc may send.
pub const EXIT_FRAMES: usize = 3;
/// Events kept while the connection is down or the rate is spent; beyond
/// this the oldest are dropped and counted (`cli.overflow`).
pub const QUEUE_MAX: usize = 60;
/// A draw counts as slow (`cli.render`) when what it showed waited this long.
pub const SLOW_RENDER: Duration = Duration::from_millis(100);
/// A control whose applied event never shows is sent without it after this.
const CONTROL_WAIT: Duration = Duration::from_secs(30);

pub const EVENT_NAMES: [&str; 7] = ["cli.turn", "cli.attach", "cli.control", "cli.render", "cli.connection", "cli.error", "cli.overflow"];

// ---- the setting ----------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Setting {
    On,
    /// `OPC_TELEMETRY=1` (overrides the settings file).
    OnByEnv,
    /// `OPC_TELEMETRY=0` or `DO_NOT_TRACK=1`.
    OffByEnv,
    /// `opc config telemetry off`.
    OffByConfig,
}

impl Setting {
    pub fn on(self) -> bool {
        matches!(self, Setting::On | Setting::OnByEnv)
    }
    pub fn why(self) -> &'static str {
        match self {
            Setting::On => "the default",
            Setting::OnByEnv => "OPC_TELEMETRY",
            Setting::OffByEnv => "the environment (OPC_TELEMETRY or DO_NOT_TRACK)",
            Setting::OffByConfig => "opc config telemetry off",
        }
    }
}

/// `$OPC_STATE_DIR/settings.json`: opc's own settings (`{"telemetry": false}`).
pub fn settings_path() -> PathBuf {
    crate::config::state_dir().join("settings.json")
}

fn env_flag(v: &str) -> Option<bool> {
    match v.trim().to_ascii_lowercase().as_str() {
        "0" | "off" | "false" | "no" => Some(false),
        "1" | "on" | "true" | "yes" => Some(true),
        _ => None,
    }
}

/// Reads the setting: the environment first, then the settings file.
pub fn read_setting() -> Setting {
    if let Some(on) = std::env::var("OPC_TELEMETRY").ok().as_deref().and_then(env_flag) {
        return if on { Setting::OnByEnv } else { Setting::OffByEnv };
    }
    if std::env::var("DO_NOT_TRACK").ok().as_deref().and_then(env_flag) == Some(true) {
        return Setting::OffByEnv;
    }
    let file = std::fs::read(settings_path()).ok().and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    match file.as_ref().and_then(|v| v.get("telemetry")).and_then(Value::as_bool) {
        Some(false) => Setting::OffByConfig,
        _ => Setting::On,
    }
}

/// Writes `telemetry` into opc's settings file, keeping other keys.
pub fn write_setting(on: bool) -> crate::error::Result<()> {
    let path = settings_path();
    let mut v = std::fs::read(&path)
        .ok()
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| json!({}));
    v["telemetry"] = Value::Bool(on);
    crate::config::write_private_json(&path, &v)
}

static ENABLED: OnceLock<bool> = OnceLock::new();

/// Whether telemetry is on for this process (read once).
pub fn enabled() -> bool {
    *ENABLED.get_or_init(|| read_setting().on())
}

/// Milliseconds, rounded to an integer.
pub fn ms(d: Duration) -> u64 {
    (d.as_secs_f64() * 1000.0).round() as u64
}

// ---- errors ---------------------------------------------------------------

/// `cli.error.class`: a closed list.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ErrorClass {
    WsClosed,
    Auth,
    Ticket,
    RateLimited,
    Protocol,
    Render,
    Crash,
    Timeout,
    Other,
}

impl ErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            ErrorClass::WsClosed => "ws_closed",
            ErrorClass::Auth => "auth",
            ErrorClass::Ticket => "ticket",
            ErrorClass::RateLimited => "rate_limited",
            ErrorClass::Protocol => "protocol",
            ErrorClass::Render => "render",
            ErrorClass::Crash => "crash",
            ErrorClass::Timeout => "timeout",
            ErrorClass::Other => "other",
        }
    }

    /// The class of a close code the wire sent.
    pub fn of_close(code: u16) -> ErrorClass {
        match code {
            4001 | 4003 => ErrorClass::Auth,
            4029 => ErrorClass::RateLimited,
            4400 | 1002 | 1003 | 1007 | 1009 => ErrorClass::Protocol,
            _ => ErrorClass::WsClosed,
        }
    }

    /// The class of a failed dial: the handshake's status or opc's code.
    pub fn of_dial(code: &str, status: Option<u16>) -> ErrorClass {
        match status {
            Some(401 | 403) => ErrorClass::Auth,
            Some(429) => ErrorClass::RateLimited,
            _ if code == "unreachable" => ErrorClass::WsClosed,
            _ => ErrorClass::of_code(code),
        }
    }

    /// The class of an opc error code (`unauthenticated`, `timeout`, …).
    pub fn of_code(code: &str) -> ErrorClass {
        match code {
            "unauthenticated" | "forbidden" | "missing_scope" => ErrorClass::Auth,
            "rate_limited" | "too_many_attached" => ErrorClass::RateLimited,
            "upgrade_required" | "usage" | "invalid_request" => ErrorClass::Protocol,
            "timeout" | "timed_out" => ErrorClass::Timeout,
            "ticket_expired" | "ticket_invalid" => ErrorClass::Ticket,
            _ => ErrorClass::Other,
        }
    }
}

// ---- the send buffer ---------------------------------------------------------

struct Queue {
    events: VecDeque<Value>,
    dropped: u64,
    /// Attaches waiting for the screen to draw them.
    attaches: Vec<AttachFact>,
    /// An interactive screen draws: attaches wait for its next frame.
    renderer: bool,
}

static QUEUE: Mutex<Queue> = Mutex::new(Queue { events: VecDeque::new(), dropped: 0, attaches: Vec::new(), renderer: false });
/// Wakes the wire task when an event is queued.
static WAKE: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// Connection writers still running: [`drain`] waits for them on exit.
static LIVE: AtomicUsize = AtomicUsize::new(0);

fn with<R>(f: impl FnOnce(&mut Queue) -> R) -> R {
    let mut q = QUEUE.lock().unwrap_or_else(|e| e.into_inner());
    f(&mut q)
}

/// The wire task waits on this between flushes.
pub fn woken() -> &'static tokio::sync::Notify {
    &WAKE
}

/// Events waiting to be sent.
pub fn pending() -> bool {
    with(|q| !q.events.is_empty() || q.dropped > 0)
}

fn epoch_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// Builds one catalog event. A session id that is not `cs_…` and a turn id
/// that is not id-shaped are left out, never sent.
pub fn event(name: &str, session_id: Option<&str>, turn_id: Option<&str>, data: Map<String, Value>) -> Value {
    let mut e = json!({"name": name, "at": epoch_ms(), "data": Value::Object(data)});
    if let Some(s) = session_id.filter(|s| crate::ids::is_session_id(s)) {
        e["sessionId"] = json!(s);
    }
    if let Some(t) = turn_id.filter(|t| valid_id(t)) {
        e["turnId"] = json!(t);
    }
    e
}

fn valid_id(t: &str) -> bool {
    !t.is_empty() && t.len() <= 64 && t.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// Queues an event; the wire sends it within about a second.
pub fn push(e: Value) {
    if !enabled() {
        return;
    }
    with(|q| {
        if q.events.len() >= QUEUE_MAX {
            q.events.pop_front();
            q.dropped += 1;
        }
        q.events.push_back(e);
    });
    WAKE.notify_one();
}

/// One error, by class.
pub fn error(class: ErrorClass, close_code: Option<u16>) {
    if !enabled() {
        return;
    }
    let mut d = Map::new();
    d.insert("class".into(), json!(class.as_str()));
    if let (ErrorClass::WsClosed, Some(c)) = (class, close_code) {
        d.insert("close_code".into(), json!(c));
    }
    push(event("cli.error", None, None, d));
}

// ---- connections ------------------------------------------------------------

/// A connection's inbound frames and bytes, counted by its reader task.
#[derive(Debug, Default)]
pub struct ConnCounts {
    frames: AtomicU64,
    bytes: AtomicU64,
}

impl ConnCounts {
    pub fn new() -> Arc<ConnCounts> {
        Arc::new(ConnCounts::default())
    }
    pub fn frame(&self, bytes: usize) {
        self.frames.fetch_add(1, Ordering::Relaxed);
        self.bytes.fetch_add(bytes as u64, Ordering::Relaxed);
    }
}

/// A connection ended: `cli.connection`.
pub fn connection_ended(counts: &ConnCounts, up: Duration, close_code: u16, reconnect: bool) {
    if !enabled() {
        return;
    }
    let mut d = Map::new();
    d.insert("up_ms".into(), json!(ms(up)));
    d.insert("frames".into(), json!(counts.frames.load(Ordering::Relaxed)));
    d.insert("bytes".into(), json!(counts.bytes.load(Ordering::Relaxed)));
    d.insert("close_code".into(), json!(close_code));
    d.insert("reconnect".into(), json!(reconnect));
    push(event("cli.connection", None, None, d));
}

/// Held by a connection's writer task while it runs, so [`drain`] can wait
/// for the last frame and the close to be written.
pub struct LiveWriter(bool);

impl LiveWriter {
    pub fn new() -> LiveWriter {
        let on = enabled();
        if on {
            LIVE.fetch_add(1, Ordering::SeqCst);
        }
        LiveWriter(on)
    }
}

impl Default for LiveWriter {
    fn default() -> Self {
        Self::new()
    }
}

impl Drop for LiveWriter {
    fn drop(&mut self) {
        if self.0 {
            LIVE.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

/// On exit: gives connection writers up to `limit` to write their last frame
/// and close. Returns at once when telemetry is off or nothing is connected.
pub async fn drain(limit: Duration) {
    if !enabled() {
        return;
    }
    let until = Instant::now() + limit;
    while LIVE.load(Ordering::SeqCst) > 0 && Instant::now() < until {
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
}

/// A token bucket for frames: a burst of 3, refilled at 6 a minute (the
/// server's limit, so opc never has a frame dropped for rate).
#[derive(Debug)]
pub struct Bucket {
    tokens: f64,
    at: Instant,
}

impl Bucket {
    pub fn new(now: Instant) -> Bucket {
        Bucket { tokens: 3.0, at: now }
    }
    pub fn take(&mut self, now: Instant) -> bool {
        let refill = now.saturating_duration_since(self.at).as_secs_f64() / 10.0;
        self.tokens = (self.tokens + refill).min(3.0);
        self.at = now;
        if self.tokens >= 1.0 {
            self.tokens -= 1.0;
            true
        } else {
            false
        }
    }
    /// When the next token is there.
    pub fn next_at(&self) -> Instant {
        self.at + Duration::from_secs_f64(((1.0 - self.tokens).max(0.0)) * 10.0)
    }
}

// ---- attaches ---------------------------------------------------------------

/// A session attached (the wire task's view).
#[derive(Debug, Clone)]
pub struct AttachFact {
    pub session_id: String,
    /// The WebSocket opened (or, for an attach asked for later, when it was asked).
    pub socket_open: Instant,
    /// Dial start → `ready`.
    pub connect: Duration,
    pub reconnect: bool,
    /// For a reconnect: when the previous socket was lost.
    pub lost_at: Option<Instant>,
    pub replayed_events: Option<u64>,
}

impl AttachFact {
    fn to_event(&self, drawn: Instant) -> Value {
        let mut d = Map::new();
        d.insert("attach_ms".into(), json!(ms(drawn.saturating_duration_since(self.socket_open))));
        d.insert("connect_ms".into(), json!(ms(self.connect)));
        d.insert("reconnect".into(), json!(self.reconnect));
        if let Some(l) = self.lost_at.filter(|_| self.reconnect) {
            d.insert("gap_ms".into(), json!(ms(drawn.saturating_duration_since(l))));
        }
        if let Some(r) = self.replayed_events {
            d.insert("replayed_events".into(), json!(r));
        }
        event("cli.attach", Some(&self.session_id), None, d)
    }
}

/// The interactive screen draws: attaches wait for its next frame.
pub fn set_renderer() {
    with(|q| q.renderer = true);
}

/// An attach result arrived. Without a screen it counts as shown now; with
/// one it waits for [`rendered`].
pub fn attached(f: AttachFact) {
    if !enabled() {
        return;
    }
    let now = Instant::now();
    let ev = with(|q| {
        if q.renderer {
            if q.attaches.len() < 16 {
                q.attaches.push(f);
            }
            None
        } else {
            Some(f.to_event(now))
        }
    });
    if let Some(e) = ev {
        push(e);
    }
}

/// The screen drew a frame: attaches waiting for it are done.
pub fn rendered(now: Instant) {
    if !enabled() {
        return;
    }
    let done = with(|q| std::mem::take(&mut q.attaches));
    for f in done {
        push(f.to_event(now));
    }
}

// ---- frames -----------------------------------------------------------------

/// The client header of every frame.
pub fn client() -> Value {
    let os = match std::env::consts::OS {
        "macos" => "darwin",
        "linux" => "linux",
        "windows" => "windows",
        _ => "other",
    };
    let arch = match std::env::consts::ARCH {
        "aarch64" => "arm64",
        "x86_64" => "x64",
        _ => "other",
    };
    json!({"name": "opc", "version": env!("CARGO_PKG_VERSION"), "os": os, "arch": arch})
}

/// The next `telemetry` notification, or `None` with nothing to send.
pub fn take_frame() -> Option<Value> {
    if !enabled() {
        return None;
    }
    let events = with(|q| {
        if q.dropped > 0 {
            let mut d = Map::new();
            d.insert("dropped".into(), json!(std::mem::take(&mut q.dropped)));
            q.events.push_front(event("cli.overflow", None, None, d));
        }
        let n = q.events.len().min(MAX_EVENTS);
        q.events.drain(..n).collect::<Vec<_>>()
    });
    frame_of(events)
}

/// Packs events into a frame under the byte limit; what does not fit goes
/// back to the front of the queue.
fn frame_of(mut events: Vec<Value>) -> Option<Value> {
    loop {
        if events.is_empty() {
            return None;
        }
        let f = json!({"jsonrpc": "2.0", "method": "telemetry", "params": {"v": 1, "client": client(), "events": events}});
        if f.to_string().len() <= MAX_FRAME_BYTES {
            return Some(f);
        }
        let back = events.pop().expect("non-empty");
        with(|q| q.events.push_front(back));
    }
}

// ---- crashes ----------------------------------------------------------------

fn crash_marker() -> PathBuf {
    crate::config::state_dir().join("telemetry-crash")
}

/// A panic leaves a marker (no message, no location); the next run with the
/// wire reports it as `cli.error {class: crash}`.
pub fn install_panic_hook() {
    if !enabled() {
        return;
    }
    let prev = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let _ = std::fs::write(crash_marker(), b"1");
        prev(info);
    }));
}

/// Reports a crash left by the previous run, once.
pub fn report_previous_crash() {
    static DONE: OnceLock<()> = OnceLock::new();
    if !enabled() || DONE.set(()).is_err() {
        return;
    }
    let path = crash_marker();
    if path.exists() && std::fs::remove_file(&path).is_ok() {
        error(ErrorClass::Crash, None);
    }
}

// ---- turns and controls -------------------------------------------------------

/// `cli.control.kind`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Control {
    Steer,
    Interrupt,
    Answer,
    Cancel,
}

impl Control {
    fn as_str(self) -> &'static str {
        match self {
            Control::Steer => "steer",
            Control::Interrupt => "interrupt",
            Control::Answer => "answer",
            Control::Cancel => "cancel",
        }
    }
}

/// Whether an event or delta of this kind is output of the agent's reply.
pub fn is_output(kind: &str) -> bool {
    matches!(
        kind,
        "message.delta" | "message.completed" | "reasoning.delta" | "reasoning.completed" | "tool.started" | "tool.preparing" | "tool.delta" | "ask.opened"
    )
}

/// A turn started by Enter, until its first output is shown.
#[derive(Debug)]
struct TurnWatch {
    /// The outgoing message that started it, until its result names the turn.
    out: Option<u64>,
    turn_id: Option<String>,
    enter: Instant,
    first_event: Option<Duration>,
    output_received: Option<Duration>,
}

impl TurnWatch {
    fn new(out: Option<u64>, turn_id: Option<String>, enter: Instant) -> TurnWatch {
        TurnWatch { out, turn_id, enter, first_event: None, output_received: None }
    }

    /// `cli.turn`: `shown` is when the first output was drawn (`None`: the
    /// turn ended, or opc left, before any).
    fn to_event(&self, session_id: &str, shown: Option<Instant>, interrupted: bool) -> Option<Value> {
        let tid = self.turn_id.as_deref()?;
        let mut d = Map::new();
        if let Some(f) = self.first_event {
            d.insert("first_event_ms".into(), json!(ms(f)));
        }
        if let Some(f) = self.output_received {
            d.insert("first_output_received_ms".into(), json!(ms(f)));
        }
        if let Some(s) = shown {
            d.insert("first_output_ms".into(), json!(ms(s.saturating_duration_since(self.enter))));
        }
        d.insert("interrupted".into(), json!(interrupted));
        Some(event("cli.turn", Some(session_id), Some(tid), d))
    }

    /// An event or delta of the session arrived; whether it is this turn's.
    fn saw(&mut self, turn_id: Option<&str>, kind: &str, now: Instant) -> bool {
        if self.turn_id.is_none() || self.turn_id.as_deref() != turn_id {
            return false;
        }
        self.first_event.get_or_insert(now.saturating_duration_since(self.enter));
        if self.output_received.is_none() && is_output(kind) {
            self.output_received = Some(now.saturating_duration_since(self.enter));
        }
        true
    }
}

#[derive(Debug)]
struct Ctl {
    kind: Control,
    key: u64,
    pressed: Instant,
    result: Option<bool>,
    round_trip: Option<Duration>,
    applied: Option<Duration>,
}

/// The interactive screen's measurements: the turn started here, controls,
/// slow draws. Called on the screen's own task; each call is a few field
/// updates, and finished events go to the send buffer.
#[derive(Debug, Default)]
pub struct Screen {
    session_id: String,
    turn: Option<TurnWatch>,
    controls: Vec<Ctl>,
    /// The oldest wire event not drawn yet.
    undrawn: Option<Instant>,
    next_key: u64,
    out: Vec<Value>,
}

impl Screen {
    pub fn new(session_id: &str) -> Screen {
        Screen { session_id: session_id.to_string(), next_key: 1 << 32, ..Screen::default() }
    }

    pub fn set_session(&mut self, id: &str) {
        self.session_id = id.to_string();
    }

    /// Enter on an idle session: a turn starts from here.
    pub fn entered(&mut self, out: u64, now: Instant) {
        self.leave_turn(false);
        self.turn = Some(TurnWatch::new(Some(out), None, now));
    }

    /// A control key; returns its key for [`Screen::result`].
    pub fn control(&mut self, kind: Control, out: Option<u64>, now: Instant) -> u64 {
        let key = out.unwrap_or_else(|| {
            self.next_key += 1;
            self.next_key
        });
        if self.controls.len() < 32 {
            self.controls.push(Ctl { kind, key, pressed: now, result: None, round_trip: None, applied: None });
        }
        key
    }

    /// The result of sending message `out` (`turns.send`, or the create that
    /// carried it): names the turn an Enter started, or answers a steer.
    pub fn sent(&mut self, out: u64, result: Result<&Value, ()>) {
        if let Some(t) = self.turn.as_mut().filter(|t| t.out == Some(out)) {
            match result.ok().and_then(|v| v.pointer("/turn/id")).and_then(Value::as_str) {
                Some(id) => {
                    t.out = None;
                    t.turn_id = Some(id.to_string());
                }
                None => self.turn = None,
            }
            return;
        }
        self.result(out, result.is_ok());
    }

    /// The server's answer to control `key` arrived.
    pub fn result(&mut self, key: u64, ok: bool) {
        if let Some(c) = self.controls.iter_mut().find(|c| c.key == key && c.result.is_none()) {
            c.result = Some(ok);
        }
    }

    /// The journal showed a control applied (the oldest of its kind waiting).
    pub fn applied(&mut self, kind: Control, now: Instant) {
        if let Some(c) = self.controls.iter_mut().find(|c| c.kind == kind && c.applied.is_none()) {
            c.applied = Some(now.saturating_duration_since(c.pressed));
        }
    }

    /// A wire event or delta of this session arrived.
    pub fn received(&mut self, turn_id: Option<&str>, kind: &str, now: Instant) {
        self.undrawn.get_or_insert(now);
        if let Some(t) = self.turn.as_mut() {
            t.saw(turn_id, kind, now);
        }
    }

    /// A turn ended. Without output it is sent now; with output received
    /// but not drawn yet, the next frame sends it (a fast turn's events can
    /// all arrive between two frames).
    pub fn turn_ended(&mut self, turn_id: &str, cancelled: bool) {
        if self.turn.as_ref().is_some_and(|t| t.turn_id.as_deref() == Some(turn_id) && t.output_received.is_none()) {
            self.leave_turn(cancelled);
        }
    }

    /// A frame was drawn at `now`; painting it took `draw`.
    pub fn drawn(&mut self, now: Instant, draw: Duration) {
        if let Some(since) = self.undrawn.take() {
            let lag = now.saturating_duration_since(since);
            if lag >= SLOW_RENDER {
                let mut d = Map::new();
                d.insert("lag_ms".into(), json!(ms(lag)));
                d.insert("draw_ms".into(), json!(ms(draw)));
                self.out.push(event("cli.render", Some(&self.session_id), None, d));
            }
        }
        if self.turn.as_ref().is_some_and(|t| t.output_received.is_some()) {
            let t = self.turn.take().expect("checked");
            self.out.extend(t.to_event(&self.session_id, Some(now), false));
        }
        let mut i = 0;
        while i < self.controls.len() {
            let c = &mut self.controls[i];
            if c.result.is_some() && c.round_trip.is_none() {
                c.round_trip = Some(now.saturating_duration_since(c.pressed));
            }
            let done = c.round_trip.is_some()
                && (c.applied.is_some() || c.result == Some(false) || now.saturating_duration_since(c.pressed) > CONTROL_WAIT);
            if done {
                let c = self.controls.remove(i);
                let e = self.control_event(&c);
                self.out.push(e);
            } else {
                i += 1;
            }
        }
        self.flush();
    }

    /// opc leaves the screen: what is still open is sent as it stands.
    pub fn leave(&mut self) {
        self.leave_turn(false);
        for c in std::mem::take(&mut self.controls) {
            if c.round_trip.is_some() || c.applied.is_some() {
                let e = self.control_event(&c);
                self.out.push(e);
            }
        }
        self.flush();
    }

    fn leave_turn(&mut self, interrupted: bool) {
        if let Some(t) = self.turn.take() {
            self.out.extend(t.to_event(&self.session_id, None, interrupted));
        }
    }

    fn control_event(&self, c: &Ctl) -> Value {
        let mut d = Map::new();
        d.insert("kind".into(), json!(c.kind.as_str()));
        if let Some(r) = c.round_trip {
            d.insert("round_trip_ms".into(), json!(ms(r)));
        }
        if let Some(a) = c.applied {
            d.insert("applied_ms".into(), json!(ms(a)));
        }
        d.insert("ok".into(), json!(c.result.unwrap_or(false)));
        event("cli.control", Some(&self.session_id), None, d)
    }

    fn flush(&mut self) {
        if cfg!(test) {
            return;
        }
        if !enabled() {
            self.out.clear();
            return;
        }
        for e in self.out.drain(..) {
            push(e);
        }
    }

    #[cfg(test)]
    fn take_out(&mut self) -> Vec<Value> {
        std::mem::take(&mut self.out)
    }
}

/// `opc -p`: the turn it started, measured from launch (a script's Enter).
/// Output is printed as it arrives, so received is shown.
static PRINT: Mutex<Option<(String, TurnWatch)>> = Mutex::new(None);

pub fn print_turn(session_id: &str, turn_id: &str) {
    if !enabled() {
        return;
    }
    let start = crate::timing::get().start;
    *PRINT.lock().unwrap_or_else(|e| e.into_inner()) = Some((session_id.to_string(), TurnWatch::new(None, Some(turn_id.to_string()), start)));
}

/// A step `opc -p` printed; only its own turn counts.
pub fn print_step(turn_id: Option<&str>, kind: &str) {
    if !enabled() {
        return;
    }
    let mut g = PRINT.lock().unwrap_or_else(|e| e.into_inner());
    let Some((_, t)) = g.as_mut() else { return };
    if !t.saw(turn_id, kind, Instant::now()) {
        return;
    }
    let ended = matches!(kind, "turn.completed" | "turn.failed" | "turn.cancelled");
    if t.output_received.is_some() || ended {
        let (sid, t) = g.take().expect("checked");
        drop(g);
        let shown = t.output_received.map(|d| t.enter + d);
        if let Some(e) = t.to_event(&sid, shown, shown.is_none() && kind == "turn.cancelled") {
            push(e);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn close_codes_map_to_closed_classes() {
        assert_eq!(ErrorClass::of_close(4001), ErrorClass::Auth);
        assert_eq!(ErrorClass::of_close(4029), ErrorClass::RateLimited);
        assert_eq!(ErrorClass::of_close(4400), ErrorClass::Protocol);
        assert_eq!(ErrorClass::of_close(1006), ErrorClass::WsClosed);
        assert_eq!(ErrorClass::of_dial("x", Some(401)), ErrorClass::Auth);
        assert_eq!(ErrorClass::of_dial("unreachable", None), ErrorClass::WsClosed);
        assert_eq!(ErrorClass::of_code("unauthenticated"), ErrorClass::Auth);
        assert_eq!(ErrorClass::of_code("something new"), ErrorClass::Other);
    }

    fn keys(e: &Value) -> Vec<String> {
        e["data"].as_object().unwrap().keys().cloned().collect()
    }

    #[test]
    fn a_turn_from_enter_to_first_drawn_output() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        s.entered(1, at(0));
        s.sent(1, Ok(&json!({"turn": {"id": "tu_1"}, "delivery": "started"})));
        // Another turn's output does not count.
        s.received(Some("tu_0"), "message.delta", at(5));
        s.drawn(at(6), Duration::ZERO);
        assert!(s.take_out().is_empty());
        s.received(Some("tu_1"), "turn.started", at(100));
        s.drawn(at(110), Duration::ZERO);
        assert!(s.take_out().is_empty(), "no output yet");
        s.received(Some("tu_1"), "message.delta", at(300));
        s.received(Some("tu_1"), "message.delta", at(305));
        s.drawn(at(320), Duration::from_millis(2));
        let out = s.take_out();
        assert_eq!(out.len(), 1, "sent as soon as the output is shown: {out:?}");
        let e = &out[0];
        assert_eq!(e["name"], "cli.turn");
        assert_eq!(e["sessionId"], "cs_7f3a9k2m4q8r1t6v");
        assert_eq!(e["turnId"], "tu_1");
        assert_eq!(e["data"]["first_event_ms"], 100);
        assert_eq!(e["data"]["first_output_received_ms"], 300);
        assert_eq!(e["data"]["first_output_ms"], 320);
        assert_eq!(e["data"]["interrupted"], false);
        let allowed = ["first_event_ms", "first_output_received_ms", "first_output_ms", "interrupted"];
        assert!(keys(e).iter().all(|k| allowed.contains(&k.as_str())), "{e}");
        // The rest of the turn adds nothing.
        for i in 0..1000 {
            s.received(Some("tu_1"), "message.delta", at(400 + i));
            s.drawn(at(401 + i), Duration::ZERO);
        }
        s.turn_ended("tu_1", false);
        s.leave();
        assert!(s.take_out().is_empty(), "one event per turn, none per delta");
    }

    #[test]
    fn a_turn_that_ends_between_two_frames_waits_for_the_frame() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        s.entered(1, at(0));
        s.sent(1, Ok(&json!({"turn": {"id": "tu_1"}})));
        s.received(Some("tu_1"), "turn.started", at(10));
        s.received(Some("tu_1"), "message.completed", at(11));
        s.received(Some("tu_1"), "turn.completed", at(12));
        s.turn_ended("tu_1", false);
        assert!(s.take_out().is_empty());
        s.drawn(at(20), Duration::ZERO);
        let out = s.take_out();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["data"]["first_output_ms"], 20);
    }

    #[test]
    fn a_turn_interrupted_before_output() {
        let t0 = Instant::now();
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        s.entered(1, t0);
        s.sent(1, Ok(&json!({"turn": {"id": "tu_1"}})));
        s.received(Some("tu_1"), "turn.started", t0 + Duration::from_millis(50));
        s.turn_ended("tu_1", true);
        let out = s.take_out();
        assert_eq!(out[0]["data"]["interrupted"], true);
        assert!(out[0]["data"].get("first_output_ms").is_none());
    }

    #[test]
    fn a_failed_send_is_not_a_turn() {
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        s.entered(1, Instant::now());
        s.sent(1, Err(()));
        s.leave();
        assert!(s.take_out().is_empty());
    }

    #[test]
    fn slow_draws_only() {
        let t0 = Instant::now();
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        s.received(None, "message.delta", t0);
        s.drawn(t0 + Duration::from_millis(16), Duration::from_millis(1));
        assert!(s.take_out().is_empty());
        s.received(None, "message.delta", t0 + Duration::from_millis(20));
        s.drawn(t0 + Duration::from_millis(250), Duration::from_millis(180));
        let out = s.take_out();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["name"], "cli.render");
        assert_eq!(out[0]["data"]["lag_ms"], 230);
        assert_eq!(out[0]["data"]["draw_ms"], 180);
    }

    #[test]
    fn steer_round_trip_and_applied() {
        let t0 = Instant::now();
        let at = |ms: u64| t0 + Duration::from_millis(ms);
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        let k = s.control(Control::Steer, Some(7), at(0));
        assert_eq!(k, 7);
        s.sent(7, Ok(&json!({"delivery": "steered"})));
        s.drawn(at(40), Duration::ZERO);
        assert!(s.take_out().is_empty(), "waits for the applied event");
        s.applied(Control::Steer, at(250));
        s.drawn(at(260), Duration::ZERO);
        let out = s.take_out();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["name"], "cli.control");
        assert_eq!(out[0]["data"]["kind"], "steer");
        assert_eq!(out[0]["data"]["round_trip_ms"], 40);
        assert_eq!(out[0]["data"]["applied_ms"], 250);
        assert_eq!(out[0]["data"]["ok"], true);
    }

    #[test]
    fn a_failed_interrupt_is_sent_at_once() {
        let t0 = Instant::now();
        let mut s = Screen::new("cs_7f3a9k2m4q8r1t6v");
        let k = s.control(Control::Interrupt, None, t0);
        s.result(k, false);
        s.drawn(t0 + Duration::from_millis(30), Duration::ZERO);
        let out = s.take_out();
        assert_eq!(out[0]["data"]["ok"], false);
        assert!(out[0]["data"].get("applied_ms").is_none());
    }

    #[test]
    fn events_never_carry_content() {
        let e = event("cli.turn", Some("cs_x"), Some("bad id with spaces"), Map::new());
        assert!(e.get("turnId").is_none());
        let e = event("cli.turn", Some("/home/me/secret"), None, Map::new());
        assert!(e.get("sessionId").is_none());
        let c = client();
        assert!(["darwin", "linux", "windows", "other"].contains(&c["os"].as_str().unwrap()));
        assert!(["arm64", "x64", "other"].contains(&c["arch"].as_str().unwrap()));
    }

    #[test]
    fn frames_stay_under_the_limits() {
        let big: Vec<Value> = (0..MAX_EVENTS)
            .map(|i| {
                let mut d = Map::new();
                for k in 0..60 {
                    d.insert(format!("k{k}_{i}"), json!(u64::MAX));
                }
                event("cli.connection", None, None, d)
            })
            .collect();
        let f = frame_of(big).expect("a frame");
        assert!(f.to_string().len() <= MAX_FRAME_BYTES);
        assert!(f["params"]["events"].as_array().unwrap().len() <= MAX_EVENTS);
        assert_eq!(f["params"]["v"], 1);
        assert_eq!(f["params"]["client"]["name"], "opc");
        assert!(f.get("id").is_none(), "a notification");
        with(|q| q.events.clear());
    }

    #[test]
    fn the_bucket_allows_a_burst_of_three_then_six_a_minute() {
        let t0 = Instant::now();
        let mut b = Bucket::new(t0);
        assert!(b.take(t0) && b.take(t0) && b.take(t0));
        assert!(!b.take(t0));
        assert_eq!(b.next_at(), t0 + Duration::from_secs(10));
        assert!(b.take(t0 + Duration::from_secs(10)));
        let mut sent = 3;
        for s in 0..60 {
            if b.take(t0 + Duration::from_secs(11 + s)) {
                sent += 1;
            }
        }
        assert!(sent <= 3 + 7, "{sent}");
    }

    #[test]
    fn env_flags() {
        assert_eq!(env_flag("0"), Some(false));
        assert_eq!(env_flag("off"), Some(false));
        assert_eq!(env_flag("1"), Some(true));
        assert_eq!(env_flag("maybe"), None);
    }
}
