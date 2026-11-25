//! The wire actor: one task owns the connection, the sessions' cursors and
//! the requests in flight, so there is a single writer for every piece of
//! state and no locks.
//!
//! Guarantees to the consumer of [`WireEvent`]s:
//! - every recorded event once, in `seq` order per session, across
//!   reconnects: a repeat (`seq <= cursor`) is skipped, a gap
//!   (`seq > cursor + 1`) is dropped and refilled by attaching again with
//!   `after: cursor`;
//! - a `logEpoch` change, or `cursor_ahead`, rolls the cursor back to
//!   `epochStartSeq - 1` and says so with [`WireEvent::EpochReset`] before the
//!   replacement events;
//! - requests not answered when a connection drops are sent again on the next
//!   one (writes carry an idempotency key, so a repeat is harmless), except
//!   after `1009 message too big`;
//! - a session too far behind (`too_far_behind`, close `4008`) is paged over
//!   HTTP until it is within 10 000 events, then attached; one the server
//!   cannot bring up to date (the events after its cursor are gone, or it is
//!   refused again and again without moving) starts again from its tail,
//!   after an [`WireEvent::EpochReset`] at its cursor.

use super::client::{self, Frame};
use super::{Attach, AttachInfo, WireEvent, WireOptions};
use crate::api::types::{Capabilities, Delta, Event, Session, Turn};
use crate::error::{Error, Result};
use crate::http::Http;
use crate::log;
use bytes::Bytes;
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{mpsc, oneshot};
use tokio::time::sleep_until;
use tokio_tungstenite::tungstenite::Message;

/// Ack after this many events, or this long after the first unacked one.
const ACK_EVERY: u32 = 64;
const ACK_AFTER: Duration = Duration::from_millis(250);
/// A socket quiet this long is probed before it is trusted with a request.
const QUIET: Duration = Duration::from_secs(15);
/// Keepalive and wake detection.
const KEEPALIVE: Duration = Duration::from_secs(20);
const MIN_PROBE: Duration = Duration::from_millis(750);
/// The server replays at most this many events on attach.
const MAX_REPLAY: u64 = 10_000;
const BACKOFF_START: Duration = Duration::from_millis(250);
const BACKOFF_MAX: Duration = Duration::from_secs(8);
/// A connection up this long resets the backoff.
const STABLE: Duration = Duration::from_secs(60);
/// How long a dial may take before it counts as failed.
const DIAL_TIMEOUT: Duration = Duration::from_secs(10);
/// A server's wait (`Retry-After`, `retryAfterMs`) is honoured up to this.
const HINT_MAX: Duration = Duration::from_secs(30);
/// Paging rounds in a row that leave a session where it was before it goes
/// to its tail instead.
const PAGE_STALLS: u32 = 6;
/// A connection whose credential ends sooner than this is not replaced: the
/// replacement would end with it.
const EXPIRY_MIN: Duration = Duration::from_secs(60);
/// A `4001` close that `/me` contradicts is retried this long (the edge sees a
/// key's changes within 60 s), then is fatal.
const REFUSED_FOR: Duration = Duration::from_secs(90);

pub struct Wire;

/// Cheap to clone. Dropping every handle closes the connection.
#[derive(Clone)]
pub struct WireHandle {
    tx: mpsc::UnboundedSender<Cmd>,
}

enum Cmd {
    Call { method: String, params: Value, reply: oneshot::Sender<Result<Value>> },
    Notify { method: String, params: Value },
    Attach(Attach),
    Detach(String),
    Binary(u32, Bytes),
    Probe,
    Close,
}

impl Wire {
    /// Starts dialing in the background and returns at once. The first
    /// sessions go in the upgrade URL.
    pub fn open(opts: WireOptions, attaches: Vec<Attach>, http: Option<Http>) -> (WireHandle, mpsc::UnboundedReceiver<WireEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (out, events) = mpsc::unbounded_channel();
        let actor = Actor::new(opts, attaches, http, out);
        tokio::spawn(actor.run(rx));
        (WireHandle { tx }, events)
    }
}

impl WireHandle {
    /// A JSON-RPC request; resolves with its `result`, or the API error.
    pub async fn call(&self, method: &str, params: Value) -> Result<Value> {
        let (reply, rx) = oneshot::channel();
        self.tx
            .send(Cmd::Call { method: method.to_string(), params, reply })
            .map_err(|_| Error::unreachable("the connection is closed"))?;
        rx.await.map_err(|_| Error::unreachable("the connection is closed"))?
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.tx.send(Cmd::Notify { method: method.to_string(), params });
    }

    pub fn attach(&self, attach: Attach) {
        let _ = self.tx.send(Cmd::Attach(attach));
    }

    pub fn detach(&self, session_id: &str) {
        let _ = self.tx.send(Cmd::Detach(session_id.to_string()));
    }

    pub fn send_binary(&self, channel: u32, data: Bytes) {
        let _ = self.tx.send(Cmd::Binary(channel, data));
    }

    /// Checks the connection now (the network changed, the machine woke).
    pub fn probe(&self) {
        let _ = self.tx.send(Cmd::Probe);
    }

    pub fn close(&self) {
        let _ = self.tx.send(Cmd::Close);
    }
}

/// The parse of an attach result or a `sessions.attached` notification.
pub fn parse_attach(v: &Value) -> Result<AttachInfo> {
    let session: Session = serde_json::from_value(v.get("session").cloned().unwrap_or(Value::Null))
        .map_err(|e| Error::new("internal", format!("the server sent a session opc cannot read: {e}")))?;
    let log_epoch = v.get("logEpoch").and_then(Value::as_u64).unwrap_or(session.log_epoch.max(1));
    let epoch_start_seq = v.get("epochStartSeq").and_then(Value::as_u64).unwrap_or(session.epoch_start_seq);
    let capabilities: Option<Capabilities> = v.get("capabilities").filter(|c| !c.is_null()).and_then(|c| serde_json::from_value(c.clone()).ok());
    let earlier_turns: Option<Vec<Turn>> = v.get("earlierTurns").filter(|c| !c.is_null()).and_then(|c| serde_json::from_value(c.clone()).ok());
    let server = v.pointer("/timing/serverUs").and_then(Value::as_u64).map(Duration::from_micros);
    Ok(AttachInfo { session, log_epoch, epoch_start_seq, capabilities, earlier_turns, server })
}

/// A JSON-RPC error object to an [`Error`].
pub fn rpc_error(e: &Value) -> Error {
    let code = e.get("code").and_then(Value::as_i64).unwrap_or(-32000);
    match e.get("data") {
        Some(data) if data.is_object() => {
            let status = data.get("status").and_then(Value::as_u64).unwrap_or(if code == -32602 { 400 } else { 500 }) as u16;
            let mut err = crate::http::api_error(status, data, &http::HeaderMap::new());
            if code == -32602 && data.get("code").is_none() {
                err.code = "invalid_request".into();
            }
            err
        }
        _ => {
            let message = e.get("message").and_then(Value::as_str).unwrap_or("request failed").to_string();
            let mut err = match code {
                -32602 | -32600 => Error::new("invalid_request", message),
                -32601 => Error::new("feature_unavailable", message),
                _ => Error::new("internal", message),
            };
            err.status = Some(if code == -32000 { 500 } else { 400 });
            err
        }
    }
}

#[derive(Debug)]
struct Sess {
    want: Attach,
    /// The last `seq` delivered.
    cursor: Option<u64>,
    epoch: Option<u64>,
    /// An attach is in flight (by request id, or `0` for the URL).
    attaching: bool,
    /// A gap was seen; a re-attach is in flight.
    resync: bool,
    /// Being paged over HTTP before attaching.
    paging: bool,
    /// The cursor the current paging round started from.
    page_from: Option<u64>,
    /// Paging rounds in a row that ended where they started.
    stalls: u32,
    /// Failed page requests in a row.
    page_errors: u32,
    /// After a reset to the tail: events up to this were delivered before.
    skip_through: Option<u64>,
    unacked: u32,
    first_unacked: Option<Instant>,
    /// Telemetry: when an attach asked for after the connection was up
    /// started (`None`: it rides the connection's open).
    attach_from: Option<Instant>,
    /// Telemetry: the connection generation this session's attach was last
    /// reported on (`0`: never), so a resync is not a second attach.
    reported_on: u64,
}

impl Sess {
    fn attach_now(&self) -> Attach {
        let mut a = self.want.clone();
        if let Some(c) = self.cursor {
            a.after = Some(c);
            a.tail_turns = None;
        }
        a
    }
}

enum Purpose {
    User(oneshot::Sender<Result<Value>>),
    Attach(String),
    Ping(Instant),
}

struct Pending {
    method: String,
    params: Value,
    purpose: Purpose,
    /// The connection generation it was written to (`None`: not yet).
    sent_on: Option<u64>,
}

struct Conn {
    generation: u64,
    tx: mpsc::UnboundedSender<Message>,
    dial_started: Instant,
    resumed_tls: bool,
    /// The server closes the connection then (`ready.expiresInMs`); a
    /// replacement is dialed before it.
    expires_at: Option<Instant>,
    /// `ready` arrived.
    ready: bool,
    up_since: Instant,
    last_rx: Instant,
    /// Sessions the URL attached on this connection.
    url_attached: Vec<String>,
    /// The WebSocket handshake finished (telemetry's "socket open").
    opened_at: Instant,
    /// Dial start → `ready`.
    took: Duration,
    counts: std::sync::Arc<crate::telemetry::ConnCounts>,
    /// Not the first connection (for `cli.connection`).
    reconnect: bool,
}

enum Internal {
    Dialed(u64, Result<client::Dialed>, Vec<String>),
    Paged { session_id: String, result: Result<(Vec<Value>, u64, bool)> },
    /// Attach again after `session.detached {reason: unavailable}`.
    Reattach(String),
    /// `/me` after a dial error (`None`) or a 4001/4003 close (its reason).
    MeChecked(Result<Option<String>>, Option<(u16, String)>),
}

struct Actor {
    opts: WireOptions,
    url: String,
    http: Option<Http>,
    out: mpsc::UnboundedSender<WireEvent>,
    sessions: HashMap<String, Sess>,
    order: Vec<String>,
    pending: BTreeMap<u64, Pending>,
    next_id: u64,
    generation: u64,
    conn: Option<Conn>,
    /// A connection open but not yet `ready`. It replaces `conn` only once
    /// `ready` arrives, so a replacement is made before the old one breaks.
    next: Option<Conn>,
    /// The generation being dialed, and when the dial started.
    dialing: Option<(u64, Instant)>,
    /// Frames of the connection being dialed that arrived before its dial
    /// was reported: its reader starts at once, and `ready` can come first.
    early: Vec<(u64, Frame)>,
    frames_tx: mpsc::UnboundedSender<(u64, Frame)>,
    frames_rx: mpsc::UnboundedReceiver<(u64, Frame)>,
    internal_tx: mpsc::UnboundedSender<Internal>,
    internal_rx: mpsc::UnboundedReceiver<Internal>,
    attempt: u32,
    retry_at: Option<Instant>,
    down_since: Option<Instant>,
    ever_connected: bool,
    refreshed_url: bool,
    probe: Option<(u64, Instant)>,
    rtt: Option<Duration>,
    last_wall: (Instant, SystemTime),
    keepalive_at: Instant,
    closed: bool,
    /// Don't resend requests after `1009`.
    drop_pending: bool,
    /// Telemetry: the next flush (about a second after an event is
    /// queued), the frame budget, and when the last connection was lost
    /// (for a reconnect's gap).
    telemetry_at: Option<Instant>,
    telemetry_bucket: crate::telemetry::Bucket,
    lost_at: Option<Instant>,
    /// The first of the `4001` closes in a row that `/me` contradicted.
    refused_since: Option<Instant>,
}

impl Actor {
    fn new(opts: WireOptions, attaches: Vec<Attach>, http: Option<Http>, out: mpsc::UnboundedSender<WireEvent>) -> Actor {
        let (frames_tx, frames_rx) = mpsc::unbounded_channel();
        let (internal_tx, internal_rx) = mpsc::unbounded_channel();
        let mut sessions = HashMap::new();
        let mut order = Vec::new();
        for a in attaches {
            if !sessions.contains_key(&a.session_id) {
                order.push(a.session_id.clone());
            }
            sessions.insert(a.session_id.clone(), new_sess(a));
        }
        let now = Instant::now();
        Actor {
            url: opts.url.clone(),
            opts,
            http,
            out,
            sessions,
            order,
            pending: BTreeMap::new(),
            next_id: 1,
            generation: 0,
            conn: None,
            next: None,
            dialing: None,
            early: Vec::new(),
            frames_tx,
            frames_rx,
            internal_tx,
            internal_rx,
            attempt: 0,
            retry_at: Some(now),
            down_since: Some(now),
            ever_connected: false,
            refreshed_url: false,
            probe: None,
            rtt: None,
            last_wall: (now, SystemTime::now()),
            keepalive_at: now + KEEPALIVE,
            closed: false,
            drop_pending: false,
            telemetry_at: None,
            telemetry_bucket: crate::telemetry::Bucket::new(now),
            lost_at: None,
            refused_since: None,
        }
    }

    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<Cmd>) {
        loop {
            if self.closed {
                break;
            }
            let deadline = self.next_deadline();
            tokio::select! {
                // Commands first: they are few, and an interrupt must not
                // wait behind a flood of inbound frames.
                biased;
                cmd = cmds.recv() => match cmd {
                    Some(cmd) => self.on_cmd(cmd),
                    None => self.close(),
                },
                frame = self.frames_rx.recv() => {
                    if let Some((generation, frame)) = frame { self.on_frame(generation, frame); }
                }
                internal = self.internal_rx.recv() => {
                    if let Some(i) = internal { self.on_internal(i); }
                }
                _ = sleep_until(deadline.into()) => self.on_timer(),
                _ = crate::telemetry::woken().notified() => {
                    let at = Instant::now() + crate::telemetry::BATCH_WAIT;
                    if self.telemetry_at.is_none_or(|t| t > at) {
                        self.telemetry_at = Some(at);
                    }
                }
            }
        }
    }

    fn emit(&self, e: WireEvent) {
        let _ = self.out.send(e);
    }

    fn next_deadline(&self) -> Instant {
        let mut d = Instant::now() + Duration::from_secs(3600);
        let mut min = |t: Instant| {
            if t < d {
                d = t;
            }
        };
        if let Some(t) = self.retry_at {
            min(t);
        }
        if let Some((_, t)) = self.probe {
            min(t);
        }
        if let Some(c) = self.conn.as_ref().filter(|c| c.ready) {
            min(self.keepalive_at);
            if let Some(t) = c.expires_at {
                min(t);
            }
            if let Some(t) = self.telemetry_at {
                min(t);
            }
        }
        for s in self.sessions.values() {
            if let Some(t) = s.first_unacked {
                min(t + ACK_AFTER);
            }
        }
        if let (Some(since), Some(limit)) = (self.down_since, self.opts.give_up) {
            min(since + limit);
        }
        d
    }

    // ---- commands ----

    fn on_cmd(&mut self, cmd: Cmd) {
        match cmd {
            Cmd::Call { method, params, reply } => {
                if self.conn.as_ref().is_some_and(|c| c.ready && c.last_rx.elapsed() > QUIET) {
                    self.start_probe();
                }
                self.request(method, params, Purpose::User(reply));
            }
            Cmd::Notify { method, params } => {
                self.write(json!({"jsonrpc": "2.0", "method": method, "params": params}));
            }
            Cmd::Attach(a) => {
                let id = a.session_id.clone();
                if !self.sessions.contains_key(&id) {
                    self.order.push(id.clone());
                }
                let mut sess = new_sess(a);
                if self.is_ready() {
                    sess.attach_from = Some(Instant::now());
                }
                self.sessions.insert(id.clone(), sess);
                if self.is_ready() {
                    self.send_attach(&id);
                }
            }
            Cmd::Detach(id) => {
                if self.sessions.remove(&id).is_some() {
                    self.order.retain(|s| s != &id);
                    if self.is_ready() {
                        let rid = self.alloc_id();
                        self.write(json!({"jsonrpc": "2.0", "id": rid, "method": "sessions.detach", "params": {"sessionId": id}}));
                    }
                }
            }
            Cmd::Binary(channel, data) => {
                if let Some(c) = &self.conn {
                    let _ = c.tx.send(client::binary_frame(channel, &data));
                }
            }
            Cmd::Probe => self.start_probe(),
            Cmd::Close => self.close(),
        }
    }

    fn close(&mut self) {
        self.flush_acks(true);
        if !self.closed
            && let Some(c) = self.conn.as_ref().filter(|c| c.ready)
        {
            crate::telemetry::connection_ended(&c.counts, c.up_since.elapsed(), 1000, c.reconnect);
            self.flush_telemetry(true);
        }
        for c in [self.conn.take(), self.next.take()].into_iter().flatten() {
            let _ = c.tx.send(Message::Close(None));
        }
        for (_, p) in std::mem::take(&mut self.pending) {
            if let Purpose::User(reply) = p.purpose {
                let _ = reply.send(Err(Error::unreachable("the connection is closed")));
            }
        }
        self.closed = true;
    }

    fn is_ready(&self) -> bool {
        self.conn.as_ref().is_some_and(|c| c.ready)
    }

    fn alloc_id(&mut self) -> u64 {
        let id = self.next_id;
        self.next_id += 1;
        id
    }

    fn request(&mut self, method: String, params: Value, purpose: Purpose) -> u64 {
        let id = self.alloc_id();
        let mut p = Pending { method, params, purpose, sent_on: None };
        if let Some(c) = self.conn.as_ref().filter(|c| c.ready) {
            let msg = json!({"jsonrpc": "2.0", "id": id, "method": p.method, "params": p.params});
            if c.tx.send(Message::Text(msg.to_string().into())).is_ok() {
                p.sent_on = Some(c.generation);
            }
        }
        self.pending.insert(id, p);
        id
    }

    fn write(&self, msg: Value) {
        if let Some(c) = self.conn.as_ref().filter(|c| c.ready) {
            let _ = c.tx.send(Message::Text(msg.to_string().into()));
        }
    }

    fn send_attach(&mut self, id: &str) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        if s.paging {
            return;
        }
        s.attaching = true;
        let a = s.attach_now();
        let mut params = json!({"sessionId": id});
        if let Some(after) = a.after {
            params["after"] = json!(after);
        }
        if let Some(t) = a.tail_turns {
            params["tailTurns"] = json!(t);
        }
        if self.opts.deltas {
            params["deltas"] = json!(true);
        }
        if self.opts.resume {
            params["resume"] = json!(true);
        }
        if self.opts.read_only {
            params["readOnly"] = json!(true);
        }
        // An earlier attach for this session still in flight is superseded.
        self.pending.retain(|_, p| !matches!(&p.purpose, Purpose::Attach(s) if s == id));
        self.request("sessions.attach".into(), params, Purpose::Attach(id.to_string()));
    }

    fn start_probe(&mut self) {
        if self.probe.is_some() || !self.is_ready() {
            return;
        }
        let rtt = self.rtt.unwrap_or(Duration::from_millis(250));
        let timeout = (rtt * 3).max(MIN_PROBE);
        let id = self.request("ping".into(), json!({}), Purpose::Ping(Instant::now()));
        self.probe = Some((id, Instant::now() + timeout));
    }

    // ---- timers ----

    fn on_timer(&mut self) {
        let now = Instant::now();
        if let (Some(since), Some(limit)) = (self.down_since, self.opts.give_up)
            && now >= since + limit {
                self.emit(WireEvent::Fatal(Error::unreachable(format!(
                    "cannot reach your computer (disconnected for {}s)",
                    limit.as_secs()
                ))));
                self.close();
                return;
            }
        if self.retry_at.is_some_and(|t| now >= t) {
            self.retry_at = None;
            self.dial();
        }
        if let Some((id, t)) = self.probe
            && now >= t {
                self.probe = None;
                self.pending.remove(&id);
                log::info("wire: the connection stopped answering; reconnecting");
                if let Some(c) = self.conn.take() {
                    let _ = c.tx.send(Message::Close(None));
                    // Dead without a close frame.
                    crate::telemetry::connection_ended(&c.counts, c.up_since.elapsed(), 1006, c.reconnect);
                    if c.up_since.elapsed() >= STABLE {
                        self.attempt = 0;
                    }
                }
                self.lost_at = Some(now);
                crate::telemetry::error(crate::telemetry::ErrorClass::Timeout, None);
                self.down_since.get_or_insert(now);
                self.redial(false);
            }
        if self.conn.as_ref().and_then(|c| c.expires_at).is_some_and(|t| now >= t) {
            if let Some(c) = self.conn.as_mut() {
                c.expires_at = None;
            }
            self.dial();
        }
        if self.is_ready() && now >= self.keepalive_at {
            self.keepalive_at = now + KEEPALIVE;
            // Wake detection: the wall clock moved further than the monotonic one.
            let (mono, wall) = self.last_wall;
            let wall_elapsed = SystemTime::now().duration_since(wall).unwrap_or_default();
            if wall_elapsed > mono.elapsed() + Duration::from_secs(5) {
                log::info("wire: woke from sleep; checking the connection");
            }
            self.start_probe();
        }
        self.last_wall = (now, SystemTime::now());
        self.flush_acks(false);
        if self.is_ready() && self.telemetry_at.is_some_and(|t| now >= t) {
            self.telemetry_at = None;
            self.flush_telemetry(false);
        }
    }

    /// Sends queued telemetry as `telemetry` notifications, within the
    /// server's rate limit; what the rate holds back goes when a token is there.
    fn flush_telemetry(&mut self, exit: bool) {
        if !self.is_ready() || !crate::telemetry::enabled() {
            return;
        }
        let mut sent = 0;
        while crate::telemetry::pending() && (!exit || sent < crate::telemetry::EXIT_FRAMES) {
            if !self.telemetry_bucket.take(Instant::now()) {
                if !exit {
                    self.telemetry_at = Some(self.telemetry_bucket.next_at());
                }
                return;
            }
            let Some(f) = crate::telemetry::take_frame() else { return };
            self.write(f);
            sent += 1;
        }
    }

    fn flush_acks(&mut self, all: bool) {
        let now = Instant::now();
        let mut acks = Vec::new();
        for (id, s) in &mut self.sessions {
            if s.unacked > 0 && (all || s.unacked >= ACK_EVERY || s.first_unacked.is_some_and(|t| now >= t + ACK_AFTER)) {
                if let Some(c) = s.cursor {
                    acks.push(json!({"jsonrpc": "2.0", "method": "sessions.ack", "params": {"sessionId": id, "seq": c}}));
                }
                s.unacked = 0;
                s.first_unacked = None;
            }
        }
        for a in acks {
            self.write(a);
        }
    }

    // ---- dialing ----

    fn dial(&mut self) {
        if self.dialing.is_some() || self.closed {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.dialing = Some((generation, Instant::now()));
        let attaches: Vec<Attach> = self
            .order
            .iter()
            .filter_map(|id| self.sessions.get(id))
            .filter(|s| !s.paging)
            .map(Sess::attach_now)
            .collect();
        let (url, in_url) = client::upgrade_url(&self.url, &attaches, &self.opts);
        for id in &in_url {
            if let Some(s) = self.sessions.get_mut(id) {
                s.attaching = true;
            }
        }
        log::debug(&format!("wire: dialing {} (attempt {})", self.url, self.attempt));
        let key = self.opts.key.clone();
        let frames = self.frames_tx.clone();
        let internal = self.internal_tx.clone();
        tokio::spawn(async move {
            let r = match tokio::time::timeout(DIAL_TIMEOUT, client::dial(&url, &key, generation, frames)).await {
                Ok(r) => r,
                Err(_) => Err(Error::unreachable("timed out connecting to your computer")),
            };
            let _ = internal.send(Internal::Dialed(generation, r, in_url));
        });
    }

    fn on_internal(&mut self, i: Internal) {
        match i {
            Internal::Dialed(generation, result, in_url) => {
                let Some((dialing, dial_started)) = self.dialing.filter(|(g, _)| *g == generation) else { return };
                let _ = dialing;
                self.dialing = None;
                let early: Vec<Frame> = std::mem::take(&mut self.early).into_iter().filter(|(g, _)| *g == generation).map(|(_, f)| f).collect();
                let ok = result.is_ok();
                match result {
                    Ok(d) => {
                        // It serves once `ready` arrives; frames are tagged.
                        let now = Instant::now();
                        if let Some(stale) = self.next.replace(Conn {
                            generation,
                            tx: d.tx,
                            dial_started,
                            resumed_tls: d.resumed_tls,
                            expires_at: None,
                            ready: false,
                            up_since: now,
                            last_rx: now,
                            url_attached: in_url,
                            opened_at: now,
                            took: Duration::ZERO,
                            counts: d.counts,
                            reconnect: self.ever_connected,
                        }) {
                            let _ = stale.tx.send(Message::Close(None));
                        }
                    }
                    Err(e) => self.on_dial_error(e, in_url),
                }
                if ok {
                    for f in early {
                        self.on_frame(generation, f);
                    }
                }
            }
            Internal::Paged { session_id, result } => self.on_paged(session_id, result),
            Internal::Reattach(id) => {
                if self.is_ready() && self.sessions.get(&id).is_some_and(|s| !s.attaching && !s.paging) {
                    self.send_attach(&id);
                }
            }
            Internal::MeChecked(result, close) => match result {
                // The key is fine but the wire refuses it this access: no
                // retry will change that.
                Ok(_) if close.as_ref().is_some_and(|(c, _)| *c == 4003) => {
                    let reason = close.map(|(_, r)| r).filter(|r| !r.is_empty()).unwrap_or_else(|| "access_denied".into());
                    self.emit(WireEvent::Fatal(Error::new("forbidden", format!("the wire refused this key access ({reason})")).with("reason", reason.as_str()).with("closeCode", 4003u64)));
                    self.close();
                }
                Ok(url) => {
                    // `/me` takes the key the wire closed with 4001: a change
                    // the edge has not seen yet, or one it never will. Retried
                    // on the backoff, but not forever.
                    if close.is_some() && self.refused_since.get_or_insert_with(Instant::now).elapsed() >= REFUSED_FOR {
                        self.emit(WireEvent::Fatal(Error::new("unauthenticated", "the wire keeps refusing this API key").hint("run `opc login`").with("closeCode", 4001u64)));
                        self.close();
                        return;
                    }
                    if let Some(u) = url {
                        if let Some(http) = &self.http {
                            crate::cache::set_wire_url(http.api_url(), &u);
                        }
                        self.url = u;
                    }
                    self.schedule_retry(None);
                }
                Err(e) if matches!(e.code.as_str(), "unauthenticated" | "forbidden") => {
                    self.emit(WireEvent::Fatal(e));
                    self.close();
                }
                Err(_) => self.schedule_retry(None),
            },
        }
    }

    fn on_dial_error(&mut self, e: Error, in_url: Vec<String>) {
        crate::telemetry::error(crate::telemetry::ErrorClass::of_dial(&e.code, e.status), None);
        for id in &in_url {
            if let Some(s) = self.sessions.get_mut(id) {
                s.attaching = false;
            }
        }
        if matches!(e.code.as_str(), "unauthenticated" | "forbidden" | "upgrade_required" | "usage") {
            self.emit(WireEvent::Fatal(e));
            self.close();
            return;
        }
        let first = !self.ever_connected && !self.refreshed_url;
        let server_side = e.status.is_some_and(|s| s >= 500) || e.message.contains("resolve") || e.message.contains("dns");
        if first && server_side && self.http.is_some() {
            // The cached wire URL may be stale: ask `/me` once.
            self.refreshed_url = true;
            let http = self.http.clone().expect("checked");
            let internal = self.internal_tx.clone();
            tokio::spawn(async move {
                let r = http.get("/me", &[]).await.map(|me| wire_url_from_me(&me));
                let _ = internal.send(Internal::MeChecked(r, None));
            });
            return;
        }
        self.schedule_retry(Some(e));
    }

    fn schedule_retry(&mut self, error: Option<Error>) {
        if self.closed {
            return;
        }
        let delay = hinted(backoff(self.attempt), error.as_ref().and_then(Error::retry_after_ms));
        self.attempt = self.attempt.saturating_add(1);
        self.retry_at = Some(Instant::now() + delay);
        // A failed replacement while the old connection serves is silent.
        if !self.is_ready() && (self.ever_connected || self.attempt > 1) {
            self.emit(WireEvent::Reconnecting {
                attempt: self.attempt,
                retry_in: delay,
                error: error.unwrap_or_else(|| Error::unreachable("the connection to your computer dropped")),
            });
        }
    }

    fn retry_after(&mut self, delay: Duration, error: Error) {
        self.attempt = self.attempt.saturating_add(1);
        self.retry_at = Some(Instant::now() + delay);
        self.emit(WireEvent::Reconnecting { attempt: self.attempt, retry_in: delay, error });
    }

    // ---- frames ----

    fn on_frame(&mut self, generation: u64, frame: Frame) {
        if self.dialing.is_some_and(|(g, _)| g == generation) {
            self.early.push((generation, frame));
            return;
        }
        if self.next.as_ref().is_some_and(|c| c.generation == generation) {
            match frame {
                Frame::Json(v) if v.get("method").and_then(Value::as_str) == Some("ready") => {
                    // Make before break: the new connection takes over.
                    let next = self.next.take().expect("checked");
                    if let Some(old) = self.conn.replace(next) {
                        let _ = old.tx.send(Message::Close(None));
                        if old.ready {
                            crate::telemetry::connection_ended(&old.counts, old.up_since.elapsed(), 1000, old.reconnect);
                        }
                    }
                    let params = v.get("params").cloned().unwrap_or(Value::Null);
                    self.on_ready(params);
                }
                Frame::Closed { code, reason } => {
                    let failed = self.next.take().expect("checked");
                    self.on_closed(failed, code, reason);
                }
                _ => log::debug("wire: a frame before ready; ignored"),
            }
            return;
        }
        let current = self.conn.as_ref().map(|c| c.generation);
        if current != Some(generation) {
            return;
        }
        if let Some(c) = self.conn.as_mut() {
            c.last_rx = Instant::now();
        }
        match frame {
            Frame::Json(v) => self.on_json(v),
            Frame::Binary(channel, data) => self.emit(WireEvent::Binary { channel, data }),
            Frame::Closed { code, reason } => {
                let c = self.conn.take().expect("checked");
                self.on_closed(c, code, reason);
            }
        }
    }

    fn on_json(&mut self, v: Value) {
        if let Some(id) = v.get("id").and_then(Value::as_u64)
            && v.get("method").is_none() {
                return self.on_response(id, v);
            }
        let method = v.get("method").and_then(Value::as_str).unwrap_or("");
        let params = v.get("params").cloned().unwrap_or(Value::Null);
        match method {
            "ready" => self.on_ready(params),
            "sessions.attached" => {
                let Some(id) = params.get("sessionId").and_then(Value::as_str).map(str::to_string) else { return };
                let result = match params.get("error").filter(|e| !e.is_null()) {
                    Some(e) => Err(crate::http::api_error(e.get("status").and_then(Value::as_u64).unwrap_or(400) as u16, e, &http::HeaderMap::new())),
                    None => Ok(params),
                };
                self.on_attach_result(&id, result);
            }
            "event" => self.on_event(Event(params)),
            "delta" => {
                let d = Delta(params);
                if self.sessions.get(d.session_id()).is_some_and(|s| !s.paging) {
                    self.emit(WireEvent::Delta(d));
                }
            }
            "session.detached" => {
                let id = params.get("sessionId").and_then(Value::as_str).unwrap_or("").to_string();
                let reason = params.get("reason").and_then(Value::as_str).unwrap_or("").to_string();
                if reason == "too_far_behind" {
                    self.start_paging(&id);
                } else if reason == "epoch_changed" && self.sessions.contains_key(&id) {
                    // The log was rewritten. Attaching again from our cursor
                    // brings `logEpoch`/`epochStartSeq` (or `cursor_ahead`),
                    // and the attach result rewinds and says EpochReset.
                    if let Some(s) = self.sessions.get_mut(&id) {
                        s.attaching = false;
                    }
                    self.send_attach(&id);
                } else if reason == "unavailable" && self.sessions.contains_key(&id) {
                    // The computer is briefly away: attach again shortly.
                    let internal = self.internal_tx.clone();
                    let wait = Duration::from_millis(500) + backoff(1) / 2;
                    tokio::spawn(async move {
                        tokio::time::sleep(wait).await;
                        let _ = internal.send(Internal::Reattach(id));
                    });
                } else if self.sessions.remove(&id).is_some() {
                    self.order.retain(|s| s != &id);
                    self.emit(WireEvent::Detached { session_id: id, reason });
                }
            }
            "terminal.exited" => self.emit(WireEvent::TerminalExited(params)),
            other => log::debug(&format!("wire: ignoring notification {other}")),
        }
    }

    fn on_ready(&mut self, params: Value) {
        let Some(c) = self.conn.as_mut() else { return };
        c.ready = true;
        let took = c.dial_started.elapsed();
        c.took = took;
        c.expires_at = params
            .get("expiresInMs")
            .and_then(Value::as_u64)
            .and_then(|ms| replace_in(Duration::from_millis(ms)))
            .map(|d| Instant::now() + d);
        let resumed_tls = c.resumed_tls;
        let generation = c.generation;
        let url_attached = c.url_attached.clone();
        let reconnect = self.ever_connected;
        self.ever_connected = true;
        self.down_since = None;
        if !reconnect {
            crate::telemetry::report_previous_crash();
        }
        if crate::telemetry::enabled() && crate::telemetry::pending() {
            // Held while disconnected: send them on the new connection.
            self.telemetry_at = Some(Instant::now() + crate::telemetry::BATCH_WAIT);
        }
        self.retry_at = None;
        self.keepalive_at = Instant::now() + KEEPALIVE;
        let connection_id = params.get("connectionId").and_then(Value::as_str).unwrap_or("").to_string();
        let region = params.pointer("/server/region").and_then(Value::as_str).map(str::to_string);
        if !reconnect {
            crate::timing::get().mark_connect(took, resumed_tls);
        }
        if let Some(r) = &region {
            crate::timing::get().edge(r);
        }
        self.emit(WireEvent::Connected { connection_id, region, took, resumed_tls, reconnect });

        // Requests not answered on the old connection go again.
        let drop_pending = std::mem::take(&mut self.drop_pending);
        let mut failed = Vec::new();
        let mut resend = Vec::new();
        for (id, p) in &mut self.pending {
            if p.sent_on == Some(generation) {
                continue;
            }
            match &p.purpose {
                Purpose::Ping(_) | Purpose::Attach(_) => failed.push(*id),
                Purpose::User(_) if drop_pending && p.sent_on.is_some() => failed.push(*id),
                Purpose::User(_) => {
                    resend.push(json!({"jsonrpc": "2.0", "id": id, "method": p.method, "params": p.params}));
                    p.sent_on = Some(generation);
                }
            }
        }
        for id in failed {
            if let Some(p) = self.pending.remove(&id)
                && let Purpose::User(reply) = p.purpose {
                    let _ = reply.send(Err(Error::new("too_large", "the message was too large for the connection")));
                }
        }
        self.probe = None;
        for m in resend {
            self.write(m);
        }
        // Sessions the URL did not attach are attached with a request.
        let ids: Vec<String> = self.order.clone();
        for id in ids {
            if url_attached.contains(&id) {
                continue;
            }
            if self.sessions.get(&id).is_some_and(|s| !s.paging) {
                self.send_attach(&id);
            }
        }
    }

    fn on_response(&mut self, id: u64, v: Value) {
        let Some(p) = self.pending.remove(&id) else { return };
        let result = match v.get("error") {
            Some(e) if !e.is_null() => Err(rpc_error(e)),
            _ => Ok(v.get("result").cloned().unwrap_or(Value::Null)),
        };
        match p.purpose {
            Purpose::User(reply) => {
                let _ = reply.send(result);
            }
            Purpose::Attach(session_id) => self.on_attach_result(&session_id, result),
            Purpose::Ping(sent) => {
                let rtt = sent.elapsed();
                self.rtt = Some(rtt);
                crate::timing::get().ping(rtt);
                if self.probe.is_some_and(|(pid, _)| pid == id) {
                    self.probe = None;
                }
            }
        }
    }

    fn on_attach_result(&mut self, id: &str, result: Result<Value>) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        s.attaching = false;
        s.resync = false;
        let cursor_before = s.cursor.or(s.want.after);
        let v = match result {
            Ok(v) => v,
            Err(e) => {
                match e.code.as_str() {
                    "cursor_ahead" => {
                        // Our cursor is past the log: it was rewritten.
                        let session = e.extra.get("session").cloned().unwrap_or(Value::Null);
                        let start = session.get("epochStartSeq").and_then(Value::as_u64).unwrap_or(0);
                        let last = session.get("lastSeq").and_then(Value::as_u64).unwrap_or(0);
                        let epoch = session.get("logEpoch").and_then(Value::as_u64);
                        let new_cursor = s.cursor.unwrap_or(0).min(start.saturating_sub(1)).min(last);
                        s.cursor = Some(new_cursor);
                        s.epoch = epoch.or(s.epoch);
                        let id = id.to_string();
                        self.emit(WireEvent::EpochReset { session_id: id.clone(), epoch_start_seq: new_cursor + 1 });
                        self.send_attach(&id);
                    }
                    "too_far_behind" => self.start_paging(id),
                    _ => {
                        let id = id.to_string();
                        self.sessions.remove(&id);
                        self.order.retain(|s| s != &id);
                        self.emit(WireEvent::Attached { session_id: id, result: Err(e) });
                    }
                }
                return;
            }
        };
        let info = match parse_attach(&v) {
            Ok(i) => i,
            Err(e) => {
                self.emit(WireEvent::Attached { session_id: id.to_string(), result: Err(e) });
                return;
            }
        };
        if let Some(c) = self.conn.as_ref()
            && s.reported_on != c.generation
            && crate::telemetry::enabled()
        {
            let reconnect = s.reported_on != 0;
            s.reported_on = c.generation;
            let socket_open = s.attach_from.take().filter(|t| *t > c.opened_at).unwrap_or(c.opened_at);
            crate::telemetry::attached(crate::telemetry::AttachFact {
                session_id: id.to_string(),
                socket_open,
                connect: c.took,
                reconnect,
                lost_at: self.lost_at,
                replayed_events: cursor_before.map(|c| info.session.last_seq.saturating_sub(c)),
            });
        }
        let known_epoch = s.epoch.or(s.want.log_epoch);
        s.epoch = Some(info.log_epoch);
        if let (Some(old), Some(c)) = (known_epoch, s.cursor)
            && old != info.log_epoch && c >= info.epoch_start_seq {
                let new_cursor = info.epoch_start_seq.saturating_sub(1);
                s.cursor = Some(new_cursor);
                let id = id.to_string();
                self.emit(WireEvent::EpochReset { session_id: id.clone(), epoch_start_seq: info.epoch_start_seq });
                self.emit(WireEvent::Attached { session_id: id.clone(), result: Ok(Box::new(info)) });
                self.send_attach(&id);
                return;
            }
        if s.cursor.is_none() && s.want.after.is_none() && s.want.tail_turns.is_none() {
            s.cursor = Some(info.session.last_seq);
        }
        if let Some(c) = s.cursor
            && info.session.last_seq > c + MAX_REPLAY {
                let id = id.to_string();
                self.emit(WireEvent::Attached { session_id: id.clone(), result: Ok(Box::new(info)) });
                self.start_paging(&id);
                return;
            }
        s.stalls = 0;
        self.emit(WireEvent::Attached { session_id: id.to_string(), result: Ok(Box::new(info)) });
    }

    fn on_event(&mut self, ev: Event) {
        let id = ev.session_id().to_string();
        let seq = ev.seq();
        let Some(s) = self.sessions.get_mut(&id) else { return };
        if s.paging {
            return;
        }
        match s.cursor {
            None if s.skip_through.is_some_and(|f| seq <= f) => return,
            Some(c) if seq <= c => return,
            Some(c) if seq > c + 1 => {
                if !s.resync {
                    log::debug(&format!("wire: gap in {id} after {c} (got {seq}); attaching again"));
                    s.resync = true;
                    self.send_attach(&id);
                    if let Some(s) = self.sessions.get_mut(&id) {
                        s.resync = true;
                    }
                }
                return;
            }
            _ => {}
        }
        s.cursor = Some(seq);
        s.unacked += 1;
        if s.first_unacked.is_none() {
            s.first_unacked = Some(Instant::now());
        }
        let ack_now = s.unacked >= ACK_EVERY;
        self.emit(WireEvent::Event(ev));
        if ack_now {
            self.flush_acks(false);
        }
    }

    fn on_closed(&mut self, c: Conn, code: u16, reason: String) {
        log::info(&format!("wire: connection closed ({code}{})", if reason.is_empty() { String::new() } else { format!(" {reason}") }));
        if c.up_since.elapsed() >= STABLE {
            self.attempt = 0;
            self.refused_since = None;
        }
        if c.ready && !self.closed {
            self.lost_at = Some(Instant::now());
        }
        if c.ready && !self.closed {
            crate::telemetry::connection_ended(&c.counts, c.up_since.elapsed(), code, c.reconnect);
        }
        if !self.closed && !matches!(code, 1000 | 1001 | 1012) {
            crate::telemetry::error(crate::telemetry::ErrorClass::of_close(code), Some(code));
        }
        if !self.is_ready() {
            self.probe = None;
            if self.down_since.is_none() {
                self.down_since = Some(Instant::now());
            }
            for s in self.sessions.values_mut() {
                s.attaching = false;
                s.resync = false;
            }
        }
        let err = |code_s: &str, msg: String| Error::unreachable(msg).with("closeCode", code_s.parse::<u64>().unwrap_or(0));
        match code {
            4400 => {
                let mut e = Error::usage(format!("the server refused the connection: {}", if reason.is_empty() { "protocol error" } else { &reason }));
                e.code = "usage".into();
                self.emit(WireEvent::Fatal(e));
                self.close();
            }
            4001 | 4003 => {
                // The key may be revoked or expired; HTTP says which.
                match self.http.clone() {
                    Some(http) => {
                        let internal = self.internal_tx.clone();
                        let close = Some((code, reason.clone()));
                        tokio::spawn(async move {
                            let r = http.get("/me", &[]).await.map(|me| wire_url_from_me(&me));
                            let _ = internal.send(Internal::MeChecked(r, close));
                        });
                    }
                    None => {
                        self.emit(WireEvent::Fatal(Error::new("unauthenticated", "the API key was refused").hint("run `opc login`")));
                        self.close();
                    }
                }
            }
            4008 => {
                let ids: Vec<String> = self.order.clone();
                for id in ids {
                    self.start_paging(&id);
                }
                self.redial(true);
            }
            4503 => {
                let ms = close_hint(&reason).unwrap_or(1000);
                self.retry_after(Duration::from_millis(ms).min(HINT_MAX), Error::new("computer_unavailable", "starting your computer"));
            }
            4029 => {
                let e = Error::new("too_many_attached", "too many connections for this key");
                let delay = hinted(backoff(self.attempt.max(3)), close_hint(&reason));
                self.retry_after(delay, e);
            }
            1009 => {
                self.drop_pending = true;
                self.redial(false);
            }
            1001 | 1012 => self.redial(true),
            _ => self.schedule_retry(Some(err(&code.to_string(), format!("the connection to your computer dropped ({code})")))),
        }
    }

    /// Dials again after a close that is no failure of ours (going away,
    /// restarting, a dead socket): at once the first time, within 250 ms
    /// when `spread` (a restarting server's clients must not all come back
    /// in the same instant), then on the backoff, so a server that keeps
    /// closing is not hammered.
    fn redial(&mut self, spread: bool) {
        let delay = redial_delay(self.attempt, spread, unit_random());
        self.attempt = self.attempt.saturating_add(1);
        self.retry_at = Some(Instant::now() + delay);
        if self.ever_connected {
            self.emit(WireEvent::Reconnecting { attempt: self.attempt, retry_in: delay, error: Error::unreachable("reconnecting") });
        }
    }

    // ---- paging over HTTP ----

    fn start_paging(&mut self, id: &str) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        if s.paging {
            return;
        }
        let Some(http) = self.http.clone() else {
            // No HTTP to page with: say so rather than strand the session
            // (attaching again would only be refused the same way).
            let id = id.to_string();
            self.sessions.remove(&id);
            self.order.retain(|s| s != &id);
            let e = Error::new("too_far_behind", format!("{id} is too far behind to catch up on the wire"));
            self.emit(WireEvent::Attached { session_id: id, result: Err(e) });
            return;
        };
        if s.stalls >= PAGE_STALLS {
            log::info(&format!("wire: {id} cannot catch up from {}; starting again from its tail", s.cursor.unwrap_or(0)));
            self.reset_to_tail(id);
            return;
        }
        s.paging = true;
        s.attaching = false;
        s.page_from = s.cursor;
        s.page_errors = 0;
        // A round right after one that went nowhere waits on the backoff.
        let delay = backoff(s.stalls);
        let after = s.cursor.unwrap_or(0);
        fetch_page(http, self.internal_tx.clone(), id.to_string(), after, delay);
    }

    fn on_paged(&mut self, id: String, result: Result<(Vec<Value>, u64, bool)>) {
        let Some(s) = self.sessions.get_mut(&id).filter(|s| s.paging) else { return };
        match result {
            Ok((events, last, more)) => {
                s.page_errors = 0;
                let mut delivered = Vec::new();
                let mut gap = false;
                for v in events {
                    let ev = Event(v);
                    let seq = ev.seq();
                    match s.cursor {
                        Some(c) if seq <= c => continue,
                        Some(c) if seq > c + 1 => {
                            gap = true;
                            break;
                        }
                        _ => {}
                    }
                    s.cursor = Some(seq);
                    delivered.push(ev);
                }
                let cursor = s.cursor.unwrap_or(0);
                let close_enough = last.saturating_sub(cursor) <= MAX_REPLAY;
                let done = close_enough || !more || delivered.is_empty();
                // The events right after the cursor are gone: no page or
                // attach will bring them back.
                let lost = gap && delivered.is_empty();
                for ev in delivered {
                    self.emit(WireEvent::Event(ev));
                }
                if lost {
                    log::info(&format!("wire: the events of {id} after {cursor} are gone; starting again from its tail"));
                    self.reset_to_tail(&id);
                } else if done {
                    self.end_paging(&id);
                } else {
                    fetch_page(self.http.clone().expect("paging needs http"), self.internal_tx.clone(), id, cursor, Duration::ZERO);
                }
            }
            // HTTP has not seen the events we have (its copy lags the
            // computer's): the wire is the way on.
            Err(e) if e.code == "cursor_ahead" => self.end_paging(&id),
            Err(e) => {
                if matches!(e.code.as_str(), "session_not_found" | "forbidden" | "unauthenticated") {
                    self.sessions.remove(&id);
                    self.order.retain(|s| s != &id);
                    self.emit(WireEvent::Attached { session_id: id, result: Err(e) });
                    return;
                }
                // Try again on the backoff; the wire is still the way back.
                s.page_errors = s.page_errors.saturating_add(1);
                let delay = hinted(backoff(s.page_errors), e.retry_after_ms());
                let after = s.cursor.unwrap_or(0);
                fetch_page(self.http.clone().expect("paging needs http"), self.internal_tx.clone(), id, after, delay);
            }
        }
    }

    /// A paging round is over: attach from where it got to. A round that
    /// did not move the cursor counts towards [`PAGE_STALLS`].
    fn end_paging(&mut self, id: &str) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        s.paging = false;
        s.stalls = if s.cursor == s.page_from { s.stalls + 1 } else { 0 };
        if self.is_ready() {
            self.send_attach(id);
        }
    }

    /// The server cannot bring this session up to date from its cursor:
    /// attach its tail instead, and tell the consumer to rebuild from there
    /// (an [`WireEvent::EpochReset`] after the cursor). Events it already
    /// has are not delivered again.
    fn reset_to_tail(&mut self, id: &str) {
        let Some(s) = self.sessions.get_mut(id) else { return };
        let cursor = s.cursor.unwrap_or(0);
        s.skip_through = Some(cursor.max(s.skip_through.unwrap_or(0)));
        s.cursor = None;
        s.want.after = None;
        s.want.tail_turns = Some(1);
        s.paging = false;
        s.stalls = 0;
        self.emit(WireEvent::EpochReset { session_id: id.to_string(), epoch_start_seq: cursor + 1 });
        if self.is_ready() {
            self.send_attach(id);
        }
    }
}

/// One page of `GET /sessions/{id}/events`, after `delay`, reported to the
/// actor: the events, `lastSeq`, and whether more remain (`hasMore`).
fn fetch_page(http: Http, internal: mpsc::UnboundedSender<Internal>, id: String, after: u64, delay: Duration) {
    tokio::spawn(async move {
        if !delay.is_zero() {
            tokio::time::sleep(delay).await;
        }
        let path = crate::http::session_path(&id, "/events");
        let q = vec![("after".to_string(), after.to_string()), ("limit".to_string(), "500".to_string())];
        let r = http.get(&path, &q).await.map(|v| page_parts(&v));
        let _ = internal.send(Internal::Paged { session_id: id, result: r });
    });
}

/// `{events, lastSeq, hasMore}`; an older server's `nextAfter` counts as more.
fn page_parts(v: &Value) -> (Vec<Value>, u64, bool) {
    let events = v.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
    let last = v.get("lastSeq").and_then(Value::as_u64).unwrap_or(0);
    let more = v.get("hasMore").and_then(Value::as_bool).unwrap_or_else(|| v.get("nextAfter").is_some_and(|n| !n.is_null()));
    (events, last, more)
}

fn new_sess(want: Attach) -> Sess {
    Sess {
        cursor: want.after,
        epoch: want.log_epoch,
        want,
        attaching: false,
        resync: false,
        paging: false,
        page_from: None,
        stalls: 0,
        page_errors: 0,
        skip_through: None,
        unacked: 0,
        first_unacked: None,
        attach_from: None,
        reported_on: 0,
    }
}

/// `computer.wireUrl`, or a top-level `wireUrl`, from `GET /me`.
pub fn wire_url_from_me(me: &Value) -> Option<String> {
    me.pointer("/computer/wireUrl")
        .or_else(|| me.get("wireUrl"))
        .and_then(Value::as_str)
        .filter(|u| u.starts_with("wss://") || u.starts_with("ws://"))
        .map(str::to_string)
}

/// Immediate, then 250 ms doubling to 8 s, with ±20 % jitter.
pub fn backoff(attempt: u32) -> Duration {
    backoff_with(attempt, unit_random())
}

/// [`backoff`] with its random draw `r` in `[0, 1]`.
fn backoff_with(attempt: u32, r: f64) -> Duration {
    if attempt == 0 {
        return Duration::ZERO;
    }
    let base = BACKOFF_START.saturating_mul(1u32 << (attempt - 1).min(6)).min(BACKOFF_MAX);
    base.mul_f64(0.8 + 0.4 * r)
}

fn unit_random() -> f64 {
    u16::from_le_bytes(crate::ids::random_bytes::<2>()) as f64 / u16::MAX as f64
}

/// The wait before [`Actor::redial`]'s dial: none the first time, or up to
/// 250 ms when `spread`; then the backoff. `r` is the random draw.
fn redial_delay(attempt: u32, spread: bool, r: f64) -> Duration {
    match attempt {
        0 if spread => BACKOFF_START.mul_f64(r),
        n => backoff_with(n, r),
    }
}

/// `delay`, or the server's wait when that is longer (up to [`HINT_MAX`]).
fn hinted(delay: Duration, hint_ms: Option<u64>) -> Duration {
    hint_ms.map_or(delay, |ms| delay.max(Duration::from_millis(ms).min(HINT_MAX)))
}

/// `retryAfterMs` from a close reason that is JSON (`4503`).
fn close_hint(reason: &str) -> Option<u64> {
    serde_json::from_str::<Value>(reason).ok().and_then(|v| v.get("retryAfterMs").and_then(Value::as_u64))
}

/// When to dial a connection's replacement, given `ready.expiresInMs`: a
/// little before it ends, or never when it ends too soon for the
/// replacement, made with the same credential, to outlive it by much.
fn replace_in(expires_in: Duration) -> Option<Duration> {
    (expires_in >= EXPIRY_MIN).then(|| expires_in.mul_f64(0.9).saturating_sub(Duration::from_secs(5)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pages_end_on_has_more() {
        let (ev, last, more) = page_parts(&serde_json::json!({"events": [{"seq": 4}], "lastSeq": 9, "hasMore": true}));
        assert_eq!((ev.len(), last, more), (1, 9, true));
        assert!(!page_parts(&serde_json::json!({"events": [], "lastSeq": 9, "hasMore": false})).2);
        // Older servers: a non-null nextAfter means more.
        assert!(page_parts(&serde_json::json!({"events": [], "lastSeq": 9, "nextAfter": 4})).2);
        assert!(!page_parts(&serde_json::json!({"events": [], "lastSeq": 9, "nextAfter": null})).2);
    }

    #[test]
    fn backoff_grows_and_caps() {
        assert_eq!(backoff(0), Duration::ZERO);
        let b1 = backoff(1);
        assert!(b1 >= Duration::from_millis(200) && b1 <= Duration::from_millis(300), "{b1:?}");
        for n in 6..20 {
            let b = backoff(n);
            assert!(b >= Duration::from_millis(6400) && b <= Duration::from_millis(9600), "{b:?}");
        }
    }

    /// An actor driven by hand: no dial runs, the handlers are called as the
    /// loop would, and times are read off `retry_at` against `Instant::now`.
    fn actor(http: bool) -> (Actor, mpsc::UnboundedReceiver<WireEvent>) {
        let (out, events) = mpsc::unbounded_channel();
        let opts = WireOptions { url: "ws://127.0.0.1:9/v1".into(), key: "k".into(), deltas: false, resume: false, read_only: false, give_up: None };
        let http = http.then(|| {
            let config = crate::config::Config {
                path: std::path::PathBuf::from("/nonexistent/opc-test-config"),
                file: Default::default(),
                api_url: "http://127.0.0.1:9".into(),
                api_key: None,
                key_source: None,
                file_error: None,
            };
            Http::new(&config).unwrap()
        });
        let attach = Attach { session_id: "cs_a".into(), after: Some(100), ..Default::default() };
        let mut a = Actor::new(opts, vec![attach], http, out);
        a.retry_at = None;
        a.ever_connected = true;
        (a, events)
    }

    fn conn(up_for: Duration) -> Conn {
        let (tx, _) = mpsc::unbounded_channel();
        let at = Instant::now() - up_for;
        Conn {
            generation: 1,
            tx,
            dial_started: at,
            resumed_tls: false,
            expires_at: None,
            ready: false,
            up_since: at,
            last_rx: at,
            url_attached: vec![],
            opened_at: at,
            took: Duration::ZERO,
            counts: crate::telemetry::ConnCounts::new(),
            reconnect: true,
        }
    }

    fn retry_in(a: &Actor) -> Duration {
        a.retry_at.expect("a retry is scheduled").saturating_duration_since(Instant::now())
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<WireEvent>) -> Vec<WireEvent> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    const SLACK: Duration = Duration::from_millis(50);

    #[test]
    fn redials_spread_then_back_off() {
        assert_eq!(redial_delay(0, false, 1.0), Duration::ZERO);
        assert_eq!(redial_delay(0, true, 0.0), Duration::ZERO);
        assert_eq!(redial_delay(0, true, 1.0), Duration::from_millis(250));
        assert_eq!(redial_delay(1, true, 0.5), Duration::from_millis(250));
        assert_eq!(redial_delay(3, false, 0.5), Duration::from_secs(1));
        assert_eq!(redial_delay(30, true, 1.0), Duration::from_millis(9600));
    }

    #[test]
    fn repeated_quick_closes_back_off() {
        for code in [1001, 1012, 4008, 1009] {
            let (mut a, _rx) = actor(false);
            let mut waits = Vec::new();
            for _ in 0..8 {
                a.on_closed(conn(Duration::from_secs(1)), code, String::new());
                waits.push(retry_in(&a));
            }
            assert!(waits[0] <= Duration::from_millis(250), "{code}: {waits:?}");
            assert!(waits[1] >= Duration::from_millis(200) - SLACK, "{code}: {waits:?}");
            assert!(waits[7] >= Duration::from_millis(6400) - SLACK, "{code}: {waits:?}");
        }
        // A connection that held a minute starts again from the quick redial.
        let (mut a, _rx) = actor(false);
        for _ in 0..5 {
            a.on_closed(conn(Duration::from_secs(1)), 1012, String::new());
        }
        a.on_closed(conn(STABLE), 1012, String::new());
        assert!(retry_in(&a) <= Duration::from_millis(250));
    }

    #[test]
    fn retry_hints_are_honoured_and_capped() {
        let (mut a, _rx) = actor(false);
        let mut e = Error::new("rate_limited", "slow down");
        e.extra.insert("retryAfterMs".into(), json!(5000));
        a.on_dial_error(e, vec![]);
        assert!(retry_in(&a) >= Duration::from_millis(5000) - SLACK && retry_in(&a) <= Duration::from_millis(5000));
        let mut e = Error::new("rate_limited", "slow down");
        e.extra.insert("retryAfterMs".into(), json!(3_600_000));
        a.on_dial_error(e, vec![]);
        assert!(retry_in(&a) <= HINT_MAX && retry_in(&a) >= HINT_MAX - SLACK);
        // Shorter than the backoff: the backoff.
        a.attempt = 6;
        let mut e = Error::new("rate_limited", "slow down");
        e.extra.insert("retryAfterMs".into(), json!(10));
        a.on_dial_error(e, vec![]);
        assert!(retry_in(&a) >= Duration::from_millis(6400) - SLACK);

        let (mut a, _rx) = actor(false);
        a.on_closed(conn(Duration::from_secs(1)), 4029, r#"{"retryAfterMs": 20000}"#.into());
        assert!(retry_in(&a) >= Duration::from_secs(20) - SLACK);
        a.on_closed(conn(Duration::from_secs(1)), 4029, "more than 50 connections".into());
        assert!(retry_in(&a) >= Duration::from_millis(800) - SLACK);
        a.on_closed(conn(Duration::from_secs(1)), 4503, r#"{"retryAfterMs": 999999}"#.into());
        assert!(retry_in(&a) <= HINT_MAX);
    }

    #[test]
    fn short_lived_credentials_are_not_replaced() {
        assert_eq!(replace_in(Duration::from_millis(5000)), None);
        assert_eq!(replace_in(Duration::ZERO), None);
        assert_eq!(replace_in(Duration::from_secs(59)), None);
        assert_eq!(replace_in(Duration::from_secs(60)), Some(Duration::from_secs(49)));
        assert_eq!(replace_in(Duration::from_secs(3600)), Some(Duration::from_secs(3235)));
        let (mut a, _rx) = actor(false);
        a.conn = Some(conn(Duration::ZERO));
        a.on_ready(json!({"connectionId": "c", "expiresInMs": 5000}));
        assert!(a.conn.as_ref().unwrap().expires_at.is_none());
        a.conn = Some(conn(Duration::ZERO));
        a.on_ready(json!({"connectionId": "c", "expiresInMs": 600_000}));
        assert!(a.conn.as_ref().unwrap().expires_at.is_some_and(|t| t > Instant::now() + Duration::from_secs(530)));
    }

    #[test]
    fn a_refused_key_that_me_accepts_is_fatal_in_the_end() {
        let (mut a, mut rx) = actor(false);
        a.on_internal(Internal::MeChecked(Ok(None), Some((4001, String::new()))));
        assert!(!a.closed && a.retry_at.is_some());
        assert!(!drain(&mut rx).iter().any(|e| matches!(e, WireEvent::Fatal(_))));
        a.on_internal(Internal::MeChecked(Ok(None), Some((4001, String::new()))));
        assert!(!a.closed);
        a.refused_since = Some(Instant::now() - REFUSED_FOR);
        a.on_internal(Internal::MeChecked(Ok(None), Some((4001, String::new()))));
        assert!(a.closed);
        let fatal = drain(&mut rx).into_iter().find_map(|e| match e {
            WireEvent::Fatal(e) => Some(e),
            _ => None,
        });
        assert_eq!(fatal.map(|e| e.exit_code()), Some(3));
        // A connection that held clears it.
        let (mut a, _rx) = actor(false);
        a.refused_since = Some(Instant::now() - REFUSED_FOR);
        a.on_closed(conn(STABLE), 1000, String::new());
        assert!(a.refused_since.is_none());
    }

    fn page(a: &mut Actor, events: &[u64], last: u64, more: bool) {
        let events = events.iter().map(|seq| json!({"sessionId": "cs_a", "seq": seq, "type": "x"})).collect();
        a.on_paged("cs_a".into(), Ok((events, last, more)));
    }

    #[tokio::test]
    async fn paging_that_goes_nowhere_ends_at_the_tail() {
        // HTTP's copy lags the wire: every page is empty, every attach is
        // refused again.
        let (mut a, mut rx) = actor(true);
        for round in 0..PAGE_STALLS {
            a.on_attach_result("cs_a", Err(Error::new("too_far_behind", "far")));
            let s = &a.sessions["cs_a"];
            assert!(s.paging, "round {round}");
            assert_eq!(s.stalls, round);
            page(&mut a, &[], 100, false);
            assert!(!a.sessions["cs_a"].paging);
        }
        assert!(drain(&mut rx).is_empty());
        a.on_attach_result("cs_a", Err(Error::new("too_far_behind", "far")));
        let s = &a.sessions["cs_a"];
        assert!(!s.paging && s.cursor.is_none() && s.want.tail_turns == Some(1) && s.want.after.is_none());
        let ev = drain(&mut rx);
        assert!(matches!(ev.as_slice(), [WireEvent::EpochReset { epoch_start_seq: 101, .. }]), "{ev:?}");
        // Events already delivered are not delivered again; the tail's are.
        a.on_event(Event(json!({"sessionId": "cs_a", "seq": 99})));
        a.on_event(Event(json!({"sessionId": "cs_a", "seq": 100})));
        a.on_event(Event(json!({"sessionId": "cs_a", "seq": 140})));
        a.on_event(Event(json!({"sessionId": "cs_a", "seq": 141})));
        let seqs: Vec<u64> = drain(&mut rx).into_iter().filter_map(|e| if let WireEvent::Event(e) = e { Some(e.seq()) } else { None }).collect();
        assert_eq!(seqs, vec![140, 141]);
    }

    #[tokio::test]
    async fn paging_that_moves_is_not_a_stall() {
        let (mut a, _rx) = actor(true);
        for round in 0..PAGE_STALLS * 2 {
            a.on_attach_result("cs_a", Err(Error::new("too_far_behind", "far")));
            let from = a.sessions["cs_a"].cursor.unwrap();
            page(&mut a, &[from + 1, from + 2], from + 20_000, false);
            assert_eq!(a.sessions["cs_a"].stalls, 0, "round {round}");
        }
    }

    #[tokio::test]
    async fn a_page_past_the_cursor_goes_to_the_tail_at_once() {
        let (mut a, mut rx) = actor(true);
        a.on_attach_result("cs_a", Err(Error::new("too_far_behind", "far")));
        page(&mut a, &[150, 151], 20_000, true);
        let s = &a.sessions["cs_a"];
        assert!(!s.paging && s.want.tail_turns == Some(1));
        assert!(matches!(drain(&mut rx).as_slice(), [WireEvent::EpochReset { epoch_start_seq: 101, .. }]));
        // A late page for a round that is over is ignored.
        page(&mut a, &[101], 20_000, true);
        assert!(drain(&mut rx).is_empty());
    }

    #[tokio::test]
    async fn page_errors_back_off_and_cursor_ahead_attaches() {
        let (mut a, _rx) = actor(true);
        a.on_attach_result("cs_a", Err(Error::new("too_far_behind", "far")));
        for n in 1..=3 {
            a.on_paged("cs_a".into(), Err(Error::new("internal", "boom")));
            assert_eq!(a.sessions["cs_a"].page_errors, n);
            assert!(a.sessions["cs_a"].paging);
        }
        a.on_paged("cs_a".into(), Err(Error::new("cursor_ahead", "ahead")));
        let s = &a.sessions["cs_a"];
        assert!(!s.paging);
        assert_eq!(s.stalls, 1);
    }

    #[test]
    fn rpc_errors_map_to_api_errors() {
        let e = rpc_error(&json!({"code": -32000, "message": "x", "data": {"code": "session_busy", "message": "busy", "status": 409}}));
        assert_eq!(e.code, "session_busy");
        assert_eq!(e.status, Some(409));
        let e = rpc_error(&json!({"code": -32602, "message": "bad params"}));
        assert_eq!(e.code, "invalid_request");
        assert_eq!(e.exit_code(), 2);
    }

    #[test]
    fn wire_url_from_me_prefers_computer() {
        assert_eq!(wire_url_from_me(&json!({"computer": {"wireUrl": "wss://a/v1"}, "wireUrl": "wss://b/v1"})).as_deref(), Some("wss://a/v1"));
        assert_eq!(wire_url_from_me(&json!({"wireUrl": "wss://b/v1"})).as_deref(), Some("wss://b/v1"));
        assert_eq!(wire_url_from_me(&json!({"wireUrl": "https://nope"})), None);
    }
}
