//! The wire actor: one task owns the connection to the computer and the
//! requests in flight, so there is a single writer for every piece of state
//! and no locks. Watching sessions is `live.rs`; a [`WireHandle`] reaches
//! both.
//!
//! Requests not answered when a connection drops are sent again on the next
//! one (writes carry an idempotency key, so a repeat is harmless), except
//! after `1009 message too big`.

use super::client::{self, Frame};
use super::redial::{self, HINT_MAX, Redial, backoff, hinted};
use super::{Attach, WireEvent, WireOptions, live};
use crate::error::{Error, Result};
use crate::http::Http;
use crate::log;
use bytes::Bytes;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::time::{Duration, Instant, SystemTime};
use tokio::sync::{mpsc, oneshot};
use tokio::time::sleep_until;
use tokio_tungstenite::tungstenite::Message;

/// A socket quiet this long is probed before it is trusted with a request.
const QUIET: Duration = Duration::from_secs(15);
/// Keepalive and wake detection.
const KEEPALIVE: Duration = Duration::from_secs(20);
const MIN_PROBE: Duration = Duration::from_millis(750);
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
    live: Option<mpsc::UnboundedSender<live::Cmd>>,
}

enum Cmd {
    Call { method: String, params: Value, reply: oneshot::Sender<Result<Value>> },
    Notify { method: String, params: Value },
    Binary(u32, Bytes),
    Probe,
    Close,
}

impl Wire {
    /// Starts dialing in the background and returns at once. Sessions are
    /// watched over the live socket and HTTP, so watching needs `http`.
    pub fn open(opts: WireOptions, attaches: Vec<Attach>, http: Option<Http>) -> (WireHandle, mpsc::UnboundedReceiver<WireEvent>) {
        let (tx, rx) = mpsc::unbounded_channel();
        let (out, events) = mpsc::unbounded_channel();
        let live = http.clone().map(|h| live::spawn(h, opts.deltas, opts.give_up, attaches, out.clone()));
        let actor = Actor::new(opts, http, out);
        tokio::spawn(actor.run(rx));
        (WireHandle { tx, live }, events)
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

    /// Watches a session: `Attached`, then its events.
    pub fn attach(&self, attach: Attach) {
        if let Some(live) = &self.live {
            let _ = live.send(live::Cmd::Attach(attach));
        }
    }

    pub fn detach(&self, session_id: &str) {
        if let Some(live) = &self.live {
            let _ = live.send(live::Cmd::Detach(session_id.to_string()));
        }
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
        if let Some(live) = &self.live {
            let _ = live.send(live::Cmd::Close);
        }
    }
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

enum Purpose {
    User(oneshot::Sender<Result<Value>>),
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
    counts: std::sync::Arc<crate::telemetry::ConnCounts>,
    /// Not the first connection (for `cli.connection`).
    reconnect: bool,
}

enum Internal {
    Dialed(u64, Result<client::Dialed>),
    /// `/me` after a dial error (`None`) or a 4001/4003 close (its reason).
    MeChecked(Result<Option<String>>, Option<(u16, String)>),
}

struct Actor {
    opts: WireOptions,
    url: String,
    http: Option<Http>,
    out: mpsc::UnboundedSender<WireEvent>,
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
    redial: Redial,
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
    /// queued) and the frame budget.
    telemetry_at: Option<Instant>,
    telemetry_bucket: crate::telemetry::Bucket,
    /// The first of the `4001` closes in a row that `/me` contradicted.
    refused_since: Option<Instant>,
}

impl Actor {
    fn new(opts: WireOptions, http: Option<Http>, out: mpsc::UnboundedSender<WireEvent>) -> Actor {
        let (frames_tx, frames_rx) = mpsc::unbounded_channel();
        let (internal_tx, internal_rx) = mpsc::unbounded_channel();
        let now = Instant::now();
        Actor {
            url: opts.url.clone(),
            opts,
            http,
            out,
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
            redial: Redial { attempt: 0, at: Some(now) },
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
        if let Some(t) = self.redial.at {
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
        if self.redial.due(now) {
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
                    self.redial.ended(c.up_since.elapsed());
                }
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

    // ---- dialing ----

    fn dial(&mut self) {
        if self.dialing.is_some() || self.closed {
            return;
        }
        self.generation += 1;
        let generation = self.generation;
        self.dialing = Some((generation, Instant::now()));
        let url = self.url.clone();
        log::debug(&format!("wire: dialing {} (attempt {})", self.url, self.redial.attempt));
        let internal = self.internal_tx.clone();
        redial::dial(url, self.opts.key.clone(), super::PROTOCOL, generation, self.frames_tx.clone(), "timed out connecting to your computer", move |g, r| {
            let _ = internal.send(Internal::Dialed(g, r));
        });
    }

    fn on_internal(&mut self, i: Internal) {
        match i {
            Internal::Dialed(generation, result) => {
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
                            counts: d.counts,
                            reconnect: self.ever_connected,
                        }) {
                            let _ = stale.tx.send(Message::Close(None));
                        }
                    }
                    Err(e) => self.on_dial_error(e),
                }
                if ok {
                    for f in early {
                        self.on_frame(generation, f);
                    }
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

    fn on_dial_error(&mut self, e: Error) {
        crate::telemetry::error(crate::telemetry::ErrorClass::of_dial(&e.code, e.status), None);
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
        let delay = self.redial.back_off(error.as_ref().and_then(Error::retry_after_ms));
        // A failed replacement while the old connection serves is silent.
        if !self.is_ready() && (self.ever_connected || self.redial.attempt > 1) {
            self.emit(WireEvent::Reconnecting {
                attempt: self.redial.attempt,
                retry_in: delay,
                error: error.unwrap_or_else(|| Error::unreachable("the connection to your computer dropped")),
            });
        }
    }

    fn retry_after(&mut self, delay: Duration, error: Error) {
        self.redial.after(delay);
        self.emit(WireEvent::Reconnecting { attempt: self.redial.attempt, retry_in: delay, error });
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
            "terminal.exited" => self.emit(WireEvent::TerminalExited(params)),
            other => log::debug(&format!("wire: ignoring notification {other}")),
        }
    }

    fn on_ready(&mut self, params: Value) {
        let Some(c) = self.conn.as_mut() else { return };
        c.ready = true;
        let took = c.dial_started.elapsed();
        c.expires_at = params
            .get("expiresInMs")
            .and_then(Value::as_u64)
            .and_then(|ms| replace_in(Duration::from_millis(ms)))
            .map(|d| Instant::now() + d);
        let resumed_tls = c.resumed_tls;
        let generation = c.generation;
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
        self.redial.at = None;
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
                Purpose::Ping(_) => failed.push(*id),
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

    fn on_closed(&mut self, c: Conn, code: u16, reason: String) {
        log::info(&format!("wire: connection closed ({code}{})", if reason.is_empty() { String::new() } else { format!(" {reason}") }));
        if self.redial.ended(c.up_since.elapsed()) {
            self.refused_since = None;
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
            4503 => {
                let ms = close_hint(&reason).unwrap_or(1000);
                self.retry_after(Duration::from_millis(ms).min(HINT_MAX), Error::new("computer_unavailable", "starting your computer"));
            }
            4029 => {
                let e = Error::new("too_many_attached", "too many connections for this key");
                let delay = hinted(backoff(self.redial.attempt.max(3)), close_hint(&reason));
                self.retry_after(delay, e);
            }
            1009 => {
                self.drop_pending = true;
                self.redial(false);
            }
            1001 | 1012 | 4008 => self.redial(true),
            _ => self.schedule_retry(Some(err(&code.to_string(), format!("the connection to your computer dropped ({code})")))),
        }
    }

    /// Dials again after a close that is no failure of ours ([`Redial::soon`]).
    fn redial(&mut self, spread: bool) {
        let delay = self.redial.soon(spread);
        if self.ever_connected {
            self.emit(WireEvent::Reconnecting { attempt: self.redial.attempt, retry_in: delay, error: Error::unreachable("reconnecting") });
        }
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

    /// An actor driven by hand: no dial runs, the handlers are called as the
    /// loop would, and times are read off `redial.at` against `Instant::now`.
    fn actor(http: bool) -> (Actor, mpsc::UnboundedReceiver<WireEvent>) {
        let (out, events) = mpsc::unbounded_channel();
        let opts = WireOptions { url: "ws://127.0.0.1:9/v1".into(), key: "k".into(), deltas: false, give_up: None };
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
        let mut a = Actor::new(opts, http, out);
        a.redial.at = None;
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
            counts: crate::telemetry::ConnCounts::new(),
            reconnect: true,
        }
    }

    fn retry_in(a: &Actor) -> Duration {
        a.redial.at.expect("a retry is scheduled").saturating_duration_since(Instant::now())
    }

    fn drain(rx: &mut mpsc::UnboundedReceiver<WireEvent>) -> Vec<WireEvent> {
        std::iter::from_fn(|| rx.try_recv().ok()).collect()
    }

    const SLACK: Duration = Duration::from_millis(50);

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
        a.on_closed(conn(redial::STABLE), 1012, String::new());
        assert!(retry_in(&a) <= Duration::from_millis(250));
    }

    #[test]
    fn retry_hints_are_honoured_and_capped() {
        let (mut a, _rx) = actor(false);
        let mut e = Error::new("rate_limited", "slow down");
        e.extra.insert("retryAfterMs".into(), json!(5000));
        a.on_dial_error(e);
        assert!(retry_in(&a) >= Duration::from_millis(5000) - SLACK && retry_in(&a) <= Duration::from_millis(5000));
        let mut e = Error::new("rate_limited", "slow down");
        e.extra.insert("retryAfterMs".into(), json!(3_600_000));
        a.on_dial_error(e);
        assert!(retry_in(&a) <= HINT_MAX && retry_in(&a) >= HINT_MAX - SLACK);
        // Shorter than the backoff: the backoff.
        a.redial.attempt = 6;
        let mut e = Error::new("rate_limited", "slow down");
        e.extra.insert("retryAfterMs".into(), json!(10));
        a.on_dial_error(e);
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
        assert!(!a.closed && a.redial.at.is_some());
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
        a.on_closed(conn(redial::STABLE), 1000, String::new());
        assert!(a.refused_since.is_none());
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
