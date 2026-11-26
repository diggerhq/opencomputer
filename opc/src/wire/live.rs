//! Watching sessions: the live socket (`GET /live`, `oc.live.v1`) and the
//! HTTP reads that go with it. One task owns every session's cursor.
//!
//! A cursor is an opaque string the server made. It is stored, sent back and
//! compared for equality; nothing here reads what is inside one.
//!
//! For each session:
//! - it starts over HTTP: the session, its capabilities and the first page
//!   of events (the whole log, a tail, or what follows a cursor kept from
//!   another run), then [`WireEvent::Attached`] and the events;
//! - once the read has caught up, `sub events:<id>` with the cursor, and
//!   `sub deltas:<id>` when deltas were asked for;
//! - a pushed range is applied when its `from` is the cursor held and
//!   ignored when its `to` is (an overlap); anything else, a `subd` or a
//!   `behind` whose head is not the cursor, is answered by reading over HTTP
//!   from the cursor, ignoring the session's frames until that read ends;
//! - `reset`, over HTTP or on the socket: every event above its `seq` is
//!   dropped ([`WireEvent::Reset`]) and reading goes on from its `cursor`;
//! - a recorded event is delivered once: a `seq` at or below the last one
//!   delivered is a repeat;
//! - a delta whose `offset` is not the length held for its block is not
//!   delivered and the block is asked for (`block`); the `whole` delta that
//!   answers replaces the block held.
//!
//! When the socket closes it is dialed again on the wire's backoff
//! ([`super::redial`]), and every session subscribes again with its cursor.

use super::client::{self, Frame};
use super::redial::{self, Redial, backoff, hinted};
use super::{Attach, AttachInfo, From, WireEvent};
use crate::api::types::{Capabilities, Delta, Event, Session, Turn};
use crate::error::{Error, Result};
use crate::http::{Http, session_path};
use crate::log;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio::time::sleep_until;
use tokio_tungstenite::tungstenite::Message;

/// WebSocket subprotocol.
pub const PROTOCOL: &str = "oc.live.v1";
/// The protocol number sent in `hello`.
const VERSION: u64 = 1;
const PAGE: &str = "500";
const PING_EVERY: Duration = Duration::from_secs(20);
/// A session this command is creating is looked for this many times, 100 ms
/// apart, before `session_not_found` is believed.
const NOT_FOUND_TRIES: u32 = 20;

pub enum Cmd {
    Attach(Attach),
    Detach(String),
    Close,
}

/// Starts the task. It ends on [`Cmd::Close`] or when every sender is gone.
pub fn spawn(http: Http, deltas: bool, give_up: Option<Duration>, attaches: Vec<Attach>, out: mpsc::UnboundedSender<WireEvent>) -> mpsc::UnboundedSender<Cmd> {
    let (tx, rx) = mpsc::unbounded_channel();
    for a in attaches {
        let _ = tx.send(Cmd::Attach(a));
    }
    let mut actor = Actor::new(Some(http), deltas, out);
    actor.give_up = give_up;
    tokio::spawn(actor.run(rx));
    tx
}

/// One page of `GET /sessions/{id}/events`.
#[derive(Debug, Default)]
struct Page {
    events: Vec<Value>,
    /// The cursor after the last event returned.
    cursor: Option<String>,
    more: bool,
    earlier: Option<Vec<Turn>>,
}

fn page_of(v: &Value) -> Page {
    Page {
        events: v.get("events").and_then(Value::as_array).cloned().unwrap_or_default(),
        cursor: v.get("cursor").and_then(Value::as_str).map(str::to_string),
        more: v.get("hasMore").and_then(Value::as_bool).unwrap_or(false),
        earlier: v.get("earlierTurns").filter(|t| !t.is_null()).and_then(|t| serde_json::from_value(t.clone()).ok()),
    }
}

/// The text held for one streamed block.
#[derive(Debug, Default)]
struct Block {
    text: String,
    /// Its length as the server counts it: UTF-16 code units.
    units: u64,
    /// `block` was sent; a `whole` delta is awaited.
    asked: bool,
}

#[derive(Debug)]
struct Watch {
    /// Tells this watch's reads from those of an earlier watch of the session.
    n: u64,
    from: From,
    cursor: Option<String>,
    /// The highest `seq` delivered or held by the caller.
    last_seq: Option<u64>,
    /// `Attached` went out.
    started: bool,
    /// An HTTP read is in flight; the session's frames are ignored.
    reading: bool,
    /// A head a frame named during the read, to compare when it ends.
    behind: Option<String>,
    /// `sub` was sent on the current socket.
    subscribed: bool,
    errors: u32,
    not_found: u32,
    blocks: HashMap<String, Block>,
    began: Instant,
}

type Snapshot = Box<(Session, Option<Capabilities>)>;

enum Internal {
    Dialed(u64, Result<client::Dialed>),
    Started { id: String, n: u64, session: Result<Snapshot>, page: Result<Page> },
    Read { id: String, n: u64, page: Result<Page> },
}

struct Conn {
    generation: u64,
    tx: mpsc::UnboundedSender<Message>,
    /// A `ping` went out and nothing has arrived since.
    quiet: bool,
    up_since: Instant,
}

struct Actor {
    http: Option<Http>,
    deltas: bool,
    out: mpsc::UnboundedSender<WireEvent>,
    watches: HashMap<String, Watch>,
    next_n: u64,
    conn: Option<Conn>,
    /// Since when a watched session has had no socket, and how long that may
    /// last before the command fails (`None`: it keeps trying).
    down_since: Option<Instant>,
    give_up: Option<Duration>,
    generation: u64,
    dialing: bool,
    redial: Redial,
    ping_at: Instant,
    frames_tx: mpsc::UnboundedSender<(u64, Frame)>,
    frames_rx: mpsc::UnboundedReceiver<(u64, Frame)>,
    internal_tx: mpsc::UnboundedSender<Internal>,
    internal_rx: mpsc::UnboundedReceiver<Internal>,
    closed: bool,
}

/// Worth another try: the network, the server, or a rate limit.
fn transient(e: &Error) -> bool {
    e.code == "unreachable" || e.retryable || e.status.is_some_and(|s| s == 429 || s >= 500)
}

fn utf16_len(s: &str) -> u64 {
    s.encode_utf16().count() as u64
}

fn stream_session<'a>(stream: &'a str, kind: &str) -> Option<&'a str> {
    stream.strip_prefix(kind).and_then(|s| s.strip_prefix(':'))
}

impl Actor {
    fn new(http: Option<Http>, deltas: bool, out: mpsc::UnboundedSender<WireEvent>) -> Actor {
        let (frames_tx, frames_rx) = mpsc::unbounded_channel();
        let (internal_tx, internal_rx) = mpsc::unbounded_channel();
        Actor {
            http,
            deltas,
            out,
            watches: HashMap::new(),
            next_n: 1,
            conn: None,
            down_since: None,
            give_up: None,
            generation: 0,
            dialing: false,
            redial: Redial::default(),
            ping_at: Instant::now() + PING_EVERY,
            frames_tx,
            frames_rx,
            internal_tx,
            internal_rx,
            closed: false,
        }
    }

    async fn run(mut self, mut cmds: mpsc::UnboundedReceiver<Cmd>) {
        while !self.closed {
            let mut deadline = Instant::now() + Duration::from_secs(3600);
            if let Some(t) = self.redial.at {
                deadline = deadline.min(t);
            }
            if self.conn.is_some() {
                deadline = deadline.min(self.ping_at);
            }
            if let (Some(since), Some(limit)) = (self.down_since, self.give_up) {
                deadline = deadline.min(since + limit);
            }
            tokio::select! {
                biased;
                cmd = cmds.recv() => match cmd {
                    Some(Cmd::Attach(a)) => self.attach(a),
                    Some(Cmd::Detach(id)) => self.detach(&id),
                    Some(Cmd::Close) | None => self.close(),
                },
                Some((generation, frame)) = self.frames_rx.recv() => self.on_frame(generation, frame),
                Some(i) = self.internal_rx.recv() => self.on_internal(i),
                _ = sleep_until(deadline.into()) => self.on_timer(),
            }
        }
    }

    fn emit(&self, e: WireEvent) {
        let _ = self.out.send(e);
    }

    fn send(&self, frame: Value) {
        if let Some(c) = &self.conn {
            let _ = c.tx.send(Message::Text(frame.to_string().into()));
        }
    }

    fn close(&mut self) {
        if let Some(c) = self.conn.take() {
            let _ = c.tx.send(Message::Close(None));
        }
        self.closed = true;
    }

    fn fatal(&mut self, e: Error) {
        self.emit(WireEvent::Fatal(e));
        self.close();
    }

    // ---- sessions ----

    fn attach(&mut self, a: Attach) {
        let n = self.next_n;
        self.next_n += 1;
        let (cursor, last_seq) = match &a.from {
            From::Cursor(c, seq) => (Some(c.clone()), *seq),
            _ => (None, None),
        };
        let id = a.session_id.clone();
        self.watches.insert(
            id.clone(),
            Watch {
                n,
                from: a.from,
                cursor,
                last_seq,
                started: false,
                reading: true,
                behind: None,
                subscribed: false,
                errors: 0,
                not_found: 0,
                blocks: HashMap::new(),
                began: Instant::now(),
            },
        );
        self.start(&id, Duration::ZERO);
        if self.conn.is_none() {
            self.down_since.get_or_insert_with(Instant::now);
            if !self.dialing && self.redial.at.is_none() {
                self.dial();
            }
        }
    }

    fn detach(&mut self, id: &str) {
        if self.watches.remove(id).is_some() {
            self.send(json!({"t": "unsub", "stream": format!("events:{id}")}));
            if self.deltas {
                self.send(json!({"t": "unsub", "stream": format!("deltas:{id}")}));
            }
        }
    }

    /// The query of the next events read: after the cursor when one is
    /// held; without one, how the session was asked to start, and after a
    /// `reset` that carried no cursor, from the start.
    fn query(w: &Watch) -> Vec<(String, String)> {
        let mut q = vec![("limit".to_string(), PAGE.to_string())];
        match (&w.cursor, &w.from) {
            (Some(c), _) => q.push(("after".into(), c.clone())),
            (None, From::Tail(n)) if !w.started => q.push(("tailTurns".into(), (*n).clamp(1, 50).to_string())),
            // The tail's cursor is the way to the end without the whole
            // log; its events are at or below the session's `lastSeq`, so
            // they count as held.
            (None, From::Now) if !w.started => q.push(("tailTurns".into(), "1".into())),
            _ => {}
        }
        q
    }

    /// The session, its capabilities and the first page, together.
    fn start(&mut self, id: &str, delay: Duration) {
        let (Some(w), Some(http)) = (self.watches.get(id), self.http.clone()) else { return };
        let (n, q, id, tx) = (w.n, Self::query(w), id.to_string(), self.internal_tx.clone());
        tokio::spawn(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let (session_path, caps_path, events_path) = (session_path(&id, ""), session_path(&id, "/capabilities"), session_path(&id, "/events"));
            let (session, caps, page) = tokio::join!(http.get(&session_path, &[]), http.get(&caps_path, &[]), http.get(&events_path, &q));
            let session = session.and_then(|v| {
                let s: Session = serde_json::from_value(v.get("session").cloned().unwrap_or(v))
                    .map_err(|e| Error::new("internal", format!("the server sent a session opc cannot read: {e}")))?;
                let caps = caps.ok().and_then(|c| serde_json::from_value(c.get("capabilities").cloned().unwrap_or(Value::Null)).ok());
                Ok(Box::new((s, caps)))
            });
            let _ = tx.send(Internal::Started { id, n, session, page: page.map(|v| page_of(&v)) });
        });
    }

    fn read(&mut self, id: &str, delay: Duration) {
        let Some(w) = self.watches.get_mut(id) else { return };
        w.reading = true;
        let Some(http) = self.http.clone() else { return };
        let (n, q, id, tx) = (w.n, Self::query(w), id.to_string(), self.internal_tx.clone());
        tokio::spawn(async move {
            if !delay.is_zero() {
                tokio::time::sleep(delay).await;
            }
            let page = http.get(&session_path(&id, "/events"), &q).await.map(|v| page_of(&v));
            let _ = tx.send(Internal::Read { id, n, page });
        });
    }

    fn on_internal(&mut self, i: Internal) {
        match i {
            Internal::Dialed(generation, result) => self.on_dialed(generation, result),
            Internal::Started { id, n, session, page } => {
                let Some(w) = self.watches.get_mut(&id).filter(|w| w.n == n) else { return };
                // A session this command is creating may not be there yet,
                // for either read.
                let missing = |e: Option<&Error>| e.is_some_and(|e| e.code == "session_not_found");
                if (missing(session.as_ref().err()) || missing(page.as_ref().err())) && w.from == From::Start && w.not_found < NOT_FOUND_TRIES {
                    w.not_found += 1;
                    return self.start(&id, Duration::from_millis(100));
                }
                match session {
                    Err(e) => {
                        if transient(&e) {
                            w.errors = w.errors.saturating_add(1);
                            let delay = backoff(w.errors);
                            self.start(&id, delay);
                        } else {
                            self.watches.remove(&id);
                            self.emit(WireEvent::Attached { session_id: id, result: Err(e) });
                        }
                    }
                    Ok(snapshot) => {
                        let (session, capabilities) = *snapshot;
                        if w.from == From::Now {
                            w.last_seq = Some(session.last_seq);
                        }
                        w.started = true;
                        w.errors = 0;
                        if crate::telemetry::enabled() {
                            crate::telemetry::attached(crate::telemetry::AttachFact {
                                session_id: id.clone(),
                                socket_open: w.began,
                                connect: Duration::ZERO,
                                reconnect: false,
                                lost_at: None,
                                replayed_events: None,
                            });
                        }
                        let earlier_turns = page.as_ref().ok().and_then(|p| p.earlier.clone());
                        let info = AttachInfo { session, capabilities, earlier_turns };
                        self.emit(WireEvent::Attached { session_id: id.clone(), result: Ok(Box::new(info)) });
                        self.on_page(&id, page);
                    }
                }
            }
            Internal::Read { id, n, page } => {
                if self.watches.get(&id).is_some_and(|w| w.n == n) {
                    self.on_page(&id, page);
                }
            }
        }
    }

    /// A read was answered: its events, `reset`, or an error.
    fn on_page(&mut self, id: &str, page: Result<Page>) {
        let Some(w) = self.watches.get_mut(id) else { return };
        match page {
            Ok(page) => {
                w.errors = 0;
                let Some(cursor) = page.cursor else {
                    return self.fatal(Error::new("internal", "the server sent events without a cursor").hint("this opc needs a newer server"));
                };
                self.deliver(id, page.events, cursor, !page.more);
                let Some(w) = self.watches.get_mut(id) else { return };
                if page.more {
                    return self.read(id, Duration::ZERO);
                }
                w.reading = false;
                // A frame that came during the read named a head the read
                // did not reach: read once more.
                if w.behind.take().is_some_and(|h| w.cursor.as_deref() != Some(h.as_str())) {
                    return self.read(id, Duration::ZERO);
                }
                self.subscribe(id);
            }
            Err(e) if e.code == "reset" => {
                let cursor = e.extra.get("cursor").and_then(Value::as_str).map(str::to_string);
                let seq = e.extra.get("seq").and_then(Value::as_u64);
                if cursor.is_none() && w.cursor.is_none() {
                    // Nothing was sent to reset from: the server cannot be read.
                    return self.fatal(Error::new("internal", format!("the server answered reset to a read from the start of {id}")));
                }
                self.reset(id, seq, cursor);
                self.read(id, Duration::ZERO);
            }
            Err(e) if transient(&e) => {
                w.errors = w.errors.saturating_add(1);
                let delay = hinted(backoff(w.errors), e.retry_after_ms());
                self.read(id, delay);
            }
            Err(e) => {
                // The session is gone, or no longer ours to read.
                log::info(&format!("live: reading {id} failed: {}", e.message));
                self.watches.remove(id);
                self.emit(WireEvent::Detached { session_id: id.to_string(), reason: e.code });
            }
        }
    }

    /// Delivers events not delivered before and takes the cursor after them.
    fn deliver(&mut self, id: &str, events: Vec<Value>, cursor: String, head: bool) {
        let Some(w) = self.watches.get_mut(id) else { return };
        let mut fresh = Vec::new();
        for v in events {
            let ev = Event(v);
            if w.last_seq.is_some_and(|l| ev.seq() <= l) {
                continue;
            }
            w.last_seq = Some(ev.seq());
            if matches!(ev.kind(), "turn.completed" | "turn.failed" | "turn.cancelled") {
                w.blocks.clear();
            }
            fresh.push(ev);
        }
        w.cursor = Some(cursor.clone());
        for ev in fresh {
            self.emit(WireEvent::Event(ev));
        }
        self.emit(WireEvent::Cursor { session_id: id.to_string(), cursor, head });
    }

    /// `reset`: what is above `seq` is dropped, and `cursor` is where to
    /// read on from. The only case in which what was read is discarded.
    fn reset(&mut self, id: &str, seq: Option<u64>, cursor: Option<String>) {
        let Some(w) = self.watches.get_mut(id) else { return };
        w.cursor = cursor.clone();
        w.blocks.clear();
        w.subscribed = false;
        if w.last_seq.is_some_and(|l| seq.is_none_or(|s| l > s)) {
            w.last_seq = seq;
            self.emit(WireEvent::Reset { session_id: id.to_string(), seq, cursor });
        }
    }

    fn subscribe(&mut self, id: &str) {
        if self.conn.is_none() {
            return;
        }
        let Some(w) = self.watches.get_mut(id) else { return };
        let Some(cursor) = w.cursor.clone().filter(|_| w.started && !w.reading && !w.subscribed) else { return };
        w.subscribed = true;
        self.send(json!({"t": "sub", "stream": format!("events:{id}"), "after": cursor}));
        if self.deltas {
            self.send(json!({"t": "sub", "stream": format!("deltas:{id}")}));
        }
    }

    // ---- the socket ----

    fn dial(&mut self) {
        let Some(http) = &self.http else { return };
        if self.dialing || self.closed {
            return;
        }
        self.dialing = true;
        self.generation += 1;
        let (generation, url, key) = (self.generation, http.live_url(), http.key().unwrap_or_default().to_string());
        let internal = self.internal_tx.clone();
        redial::dial(url, key, PROTOCOL, generation, self.frames_tx.clone(), "timed out connecting to the live socket", move |g, r| {
            let _ = internal.send(Internal::Dialed(g, r));
        });
    }

    fn on_dialed(&mut self, generation: u64, result: Result<client::Dialed>) {
        self.dialing = false;
        match result {
            Ok(d) => {
                self.conn = Some(Conn { generation, tx: d.tx, quiet: false, up_since: Instant::now() });
                self.down_since = None;
                self.ping_at = Instant::now() + PING_EVERY;
                self.send(json!({"t": "hello", "protocol": VERSION}));
                let ids: Vec<String> = self.watches.keys().cloned().collect();
                for id in ids {
                    if let Some(w) = self.watches.get_mut(&id) {
                        w.subscribed = false;
                    }
                    self.subscribe(&id);
                }
            }
            Err(e) if matches!(e.code.as_str(), "upgrade_required" | "usage") => self.fatal(e),
            Err(e) => {
                log::debug(&format!("live: cannot connect: {}", e.message));
                if !self.closed {
                    self.redial.back_off(e.retry_after_ms());
                }
            }
        }
    }

    fn on_timer(&mut self) {
        let now = Instant::now();
        if let (Some(since), Some(limit)) = (self.down_since, self.give_up)
            && now >= since + limit
        {
            return self.fatal(Error::unreachable(format!("cannot reach the live socket (disconnected for {}s)", limit.as_secs())));
        }
        if self.redial.due(now) {
            self.dial();
        }
        if self.conn.is_some() && now >= self.ping_at {
            self.ping_at = now + PING_EVERY;
            if self.conn.as_ref().is_some_and(|c| c.quiet) {
                log::info("live: the socket stopped answering; connecting again");
                self.lost();
                self.dial();
            } else {
                self.send(json!({"t": "ping"}));
                if let Some(c) = self.conn.as_mut() {
                    c.quiet = true;
                }
            }
        }
    }

    fn lost(&mut self) {
        if let Some(c) = self.conn.take() {
            let _ = c.tx.send(Message::Close(None));
            self.redial.ended(c.up_since.elapsed());
        }
        for w in self.watches.values_mut() {
            w.subscribed = false;
            // A `whole` delta asked for on this socket will not come.
            w.blocks.values_mut().for_each(|b| b.asked = false);
        }
        if !self.watches.is_empty() {
            self.down_since.get_or_insert_with(Instant::now);
        }
    }

    fn on_frame(&mut self, generation: u64, frame: Frame) {
        let Some(c) = self.conn.as_mut().filter(|c| c.generation == generation) else { return };
        c.quiet = false;
        match frame {
            Frame::Json(v) => self.on_json(&v),
            Frame::Binary(..) => {}
            Frame::Closed { code, reason } => {
                log::info(&format!("live: socket closed ({code}{})", if reason.is_empty() { String::new() } else { format!(" {reason}") }));
                self.lost();
                if code == 4400 {
                    let mut e = Error::usage(format!("the server refused the live socket: {}", if reason.is_empty() { "protocol error" } else { &reason }));
                    e.code = "usage".into();
                    return self.fatal(e);
                }
                if code == 4003 {
                    return self.fatal(Error::new("forbidden", format!("the live socket refused this key access ({reason})")).with("reason", reason.as_str()).with("closeCode", 4003u64));
                }
                if !self.closed {
                    // Going away or restarting: come back soon, spread out.
                    if matches!(code, 1001 | 1012 | 4008) {
                        self.redial.soon(true);
                    } else {
                        self.redial.back_off(None);
                    }
                }
            }
        }
    }

    fn on_json(&mut self, v: &Value) {
        let str_of = |k: &str| v.get(k).and_then(Value::as_str);
        match str_of("t").unwrap_or("") {
            "subd" | "behind" => {
                let Some(id) = str_of("stream").and_then(|s| stream_session(s, "events")).map(str::to_string) else { return };
                let head = str_of("head");
                let Some(w) = self.watches.get_mut(&id) else { return };
                if w.reading {
                    if let Some(h) = head {
                        w.behind = Some(h.to_string());
                    }
                } else if head.is_none() || head != w.cursor.as_deref() {
                    self.read(&id, Duration::ZERO);
                }
            }
            "events" => {
                let Some(id) = str_of("session").map(str::to_string) else { return };
                let (from, Some(to)) = (str_of("from"), str_of("to")) else { return };
                let Some(w) = self.watches.get_mut(&id) else { return };
                if w.reading {
                    w.behind = Some(to.to_string());
                } else if from.is_some() && from == w.cursor.as_deref() {
                    let events = v.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
                    self.deliver(&id, events, to.to_string(), true);
                } else if Some(to) != w.cursor.as_deref() {
                    self.read(&id, Duration::ZERO);
                }
            }
            "delta" => self.on_delta(v),
            "reset" => {
                let Some(id) = str_of("stream").and_then(|s| stream_session(s, "events")).map(str::to_string) else { return };
                if !self.watches.contains_key(&id) {
                    return;
                }
                self.reset(&id, v.get("seq").and_then(Value::as_u64), str_of("cursor").map(str::to_string));
                // An answer of a read in flight is of the old cursor: its
                // own `reset` or events end at the same place.
                if self.watches.get(&id).is_some_and(|w| !w.reading) {
                    self.read(&id, Duration::ZERO);
                }
            }
            "detached" => {
                let Some(id) = str_of("stream").and_then(|s| stream_session(s, "events")).map(str::to_string) else { return };
                if self.watches.remove(&id).is_some() {
                    self.emit(WireEvent::Detached { session_id: id, reason: str_of("reason").unwrap_or("").to_string() });
                }
            }
            "error" => log::warn(&format!("live: {}: {}", str_of("code").unwrap_or("error"), str_of("message").unwrap_or(""))),
            _ => {}
        }
    }

    /// A delta is the consumer's `{type, sessionId, turnId, data}`. One with
    /// a `blockId` is checked against the text held for the block.
    fn on_delta(&mut self, v: &Value) {
        let Some(id) = v.get("session").and_then(Value::as_str).map(str::to_string) else { return };
        let Some(w) = self.watches.get_mut(&id).filter(|w| w.started) else { return };
        let mut data = v.get("data").cloned().unwrap_or(Value::Null);
        if let Some(block_id) = data.get("blockId").and_then(Value::as_str).map(str::to_string) {
            let text = data.get("text").and_then(Value::as_str).unwrap_or("").to_string();
            let b = w.blocks.entry(block_id.clone()).or_default();
            if v.get("whole").and_then(Value::as_bool) == Some(true) {
                // The block so far replaces the copy held. What goes on is
                // what the consumer has not been given: it can only append.
                let rest = text.strip_prefix(b.text.as_str()).unwrap_or("").to_string();
                b.units = utf16_len(&text);
                b.text = text;
                b.asked = false;
                if rest.is_empty() {
                    return;
                }
                data["text"] = json!(rest);
            } else if v.get("offset").and_then(Value::as_u64) == Some(b.units) {
                b.units += utf16_len(&text);
                b.text.push_str(&text);
            } else {
                if !b.asked {
                    b.asked = true;
                    self.send(json!({"t": "block", "session": id, "blockId": block_id}));
                }
                return;
            }
        }
        let delta = json!({"type": v.get("type"), "sessionId": id, "turnId": v.get("turnId"), "data": data});
        self.emit(WireEvent::Delta(Delta(delta)));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn actor(sessions: &[(&str, From)]) -> (Actor, mpsc::UnboundedReceiver<WireEvent>, mpsc::UnboundedReceiver<Message>) {
        let (out, rx) = mpsc::unbounded_channel();
        let mut a = Actor::new(None, true, out);
        let (tx, sent) = mpsc::unbounded_channel();
        a.conn = Some(Conn { generation: 1, tx, quiet: false, up_since: Instant::now() });
        for (id, from) in sessions {
            a.attach(Attach { session_id: id.to_string(), from: from.clone() });
            let w = a.watches.get_mut(*id).unwrap();
            w.started = true;
        }
        (a, rx, sent)
    }

    fn ev(seq: u64) -> Value {
        json!({"seq": seq, "sessionId": "cs_a", "type": "message.completed", "data": {}})
    }

    fn page(seqs: &[u64], cursor: &str, more: bool) -> Result<Page> {
        Ok(Page { events: seqs.iter().map(|s| ev(*s)).collect(), cursor: Some(cursor.into()), more, earlier: None })
    }

    fn reset_error(seq: Option<u64>, cursor: Option<&str>) -> Error {
        Error::from_api(409, &json!({"error": {"code": "reset", "message": "the cursor's position no longer exists", "cursor": cursor, "seq": seq}}))
    }

    fn drain<T>(rx: &mut mpsc::UnboundedReceiver<T>) -> Vec<T> {
        let mut v = Vec::new();
        while let Ok(e) = rx.try_recv() {
            v.push(e);
        }
        v
    }

    fn seqs(events: &[WireEvent]) -> Vec<u64> {
        events.iter().filter_map(|e| if let WireEvent::Event(e) = e { Some(e.seq()) } else { None }).collect()
    }

    fn frames(sent: &mut mpsc::UnboundedReceiver<Message>) -> Vec<Value> {
        drain(sent).into_iter().filter_map(|m| if let Message::Text(t) = m { serde_json::from_str(t.as_str()).ok() } else { None }).collect()
    }

    #[tokio::test]
    async fn a_page_is_delivered_once_and_then_subscribed_with_its_cursor() {
        let (mut a, mut rx, mut sent) = actor(&[("cs_a", From::Start)]);
        a.on_page("cs_a", page(&[1, 2, 2, 1, 3], "c3", false));
        let got = drain(&mut rx);
        assert_eq!(seqs(&got), vec![1, 2, 3]);
        assert!(matches!(got.last(), Some(WireEvent::Cursor { cursor, .. }) if cursor == "c3"));
        let f = frames(&mut sent);
        assert_eq!(f[0], json!({"t": "sub", "stream": "events:cs_a", "after": "c3"}));
        assert_eq!(f[1], json!({"t": "sub", "stream": "deltas:cs_a"}));
    }

    #[tokio::test]
    async fn frames_apply_by_cursor_equality_only() {
        let (mut a, mut rx, _sent) = actor(&[("cs_a", From::Start)]);
        a.on_page("cs_a", page(&[1], "opaque-1", false));
        drain(&mut rx);
        // Chained: applied.
        a.on_json(&json!({"t": "events", "session": "cs_a", "from": "opaque-1", "to": "zzz", "events": [ev(2)]}));
        assert_eq!(seqs(&drain(&mut rx)), vec![2]);
        assert_eq!(a.watches["cs_a"].cursor.as_deref(), Some("zzz"));
        // An overlap (its `to` is the cursor held): ignored.
        a.on_json(&json!({"t": "events", "session": "cs_a", "from": "opaque-1", "to": "zzz", "events": [ev(2)]}));
        assert!(drain(&mut rx).is_empty());
        assert!(!a.watches["cs_a"].reading);
        // A range that starts elsewhere: nothing applied, a read begins.
        a.on_json(&json!({"t": "events", "session": "cs_a", "from": "aaa", "to": "bbb", "events": [ev(9)]}));
        assert!(drain(&mut rx).is_empty());
        assert!(a.watches["cs_a"].reading);
        // Frames during the read are ignored, and remembered.
        a.on_json(&json!({"t": "events", "session": "cs_a", "from": "bbb", "to": "ccc", "events": [ev(10)]}));
        assert!(drain(&mut rx).is_empty());
        assert_eq!(a.watches["cs_a"].behind.as_deref(), Some("ccc"));
        // The read ends short of that head: it reads again.
        a.on_page("cs_a", page(&[3], "bbb", false));
        assert_eq!(seqs(&drain(&mut rx)), vec![3]);
        assert!(a.watches["cs_a"].reading);
        a.on_page("cs_a", page(&[4], "ccc", false));
        assert!(!a.watches["cs_a"].reading);
    }

    #[tokio::test]
    async fn subd_and_behind_read_unless_the_head_is_the_cursor() {
        let (mut a, mut rx, _sent) = actor(&[("cs_a", From::Start)]);
        a.on_page("cs_a", page(&[1], "c1", false));
        drain(&mut rx);
        a.on_json(&json!({"t": "subd", "stream": "events:cs_a", "head": "c1"}));
        assert!(!a.watches["cs_a"].reading);
        a.on_json(&json!({"t": "behind", "stream": "events:cs_a", "head": "c2"}));
        assert!(a.watches["cs_a"].reading);
        a.on_page("cs_a", page(&[2], "c2", false));
        a.on_json(&json!({"t": "subd", "stream": "events:cs_a", "head": null}));
        assert!(a.watches["cs_a"].reading);
    }

    #[tokio::test]
    async fn reset_drops_above_its_seq_and_reads_from_its_cursor() {
        let (mut a, mut rx, _sent) = actor(&[("cs_a", From::Start)]);
        a.on_page("cs_a", page(&[1, 2, 3, 4, 5], "old-5", false));
        drain(&mut rx);
        // Over HTTP.
        a.on_page("cs_a", Err(reset_error(Some(3), Some("new-3"))));
        let got = drain(&mut rx);
        assert!(matches!(&got[..], [WireEvent::Reset { seq: Some(3), cursor: Some(c), .. }] if c == "new-3"));
        assert_eq!(a.watches["cs_a"].cursor.as_deref(), Some("new-3"));
        assert!(a.watches["cs_a"].reading);
        // The rewritten tail is delivered, though its seqs were seen before.
        a.on_page("cs_a", page(&[4, 5, 6], "new-6", false));
        assert_eq!(seqs(&drain(&mut rx)), vec![4, 5, 6]);
        // On the socket, with no seq and no cursor: everything goes.
        a.on_json(&json!({"t": "reset", "stream": "events:cs_a", "cursor": null}));
        let got = drain(&mut rx);
        assert!(matches!(&got[..], [WireEvent::Reset { seq: None, cursor: None, .. }]));
        assert_eq!(Actor::query(&a.watches["cs_a"]), vec![("limit".to_string(), "500".to_string())]);
        a.on_page("cs_a", page(&[1, 2], "again-2", false));
        assert_eq!(seqs(&drain(&mut rx)), vec![1, 2]);
    }

    #[tokio::test]
    async fn a_reset_that_drops_nothing_only_moves_the_cursor() {
        let (mut a, mut rx, _sent) = actor(&[("cs_a", From::Cursor("past-the-end".into(), Some(4)))]);
        a.on_page("cs_a", Err(reset_error(Some(4), Some("end-4"))));
        assert!(drain(&mut rx).is_empty());
        assert_eq!(Actor::query(&a.watches["cs_a"])[1], ("after".to_string(), "end-4".to_string()));
    }

    #[tokio::test]
    async fn starts_ask_for_what_was_wanted() {
        let (mut a, _rx, _sent) = actor(&[("cs_a", From::Tail(3)), ("cs_b", From::Now), ("cs_c", From::Cursor("k".into(), None)), ("cs_d", From::Start)]);
        for w in a.watches.values_mut() {
            w.started = false;
        }
        let q = |id: &str| Actor::query(&a.watches[id])[1..].to_vec();
        assert_eq!(q("cs_a"), vec![("tailTurns".to_string(), "3".to_string())]);
        assert_eq!(q("cs_b"), vec![("tailTurns".to_string(), "1".to_string())]);
        assert_eq!(q("cs_c"), vec![("after".to_string(), "k".to_string())]);
        assert!(q("cs_d").is_empty());
    }

    #[tokio::test]
    async fn deltas_follow_offsets_and_a_whole_replaces_the_block() {
        let (mut a, mut rx, mut sent) = actor(&[("cs_a", From::Start)]);
        a.on_page("cs_a", page(&[1], "c1", false));
        drain(&mut rx);
        frames(&mut sent);
        let delta = |text: &str, offset: u64, whole: bool| {
            let mut d = json!({"t": "delta", "session": "cs_a", "type": "message.delta", "turnId": "tn_1", "data": {"blockId": "b1", "text": text}, "offset": offset});
            if whole {
                d["whole"] = json!(true);
            }
            d
        };
        let texts = |rx: &mut mpsc::UnboundedReceiver<WireEvent>| -> Vec<String> {
            drain(rx).into_iter().filter_map(|e| if let WireEvent::Delta(d) = e { Some(d.text().to_string()) } else { None }).collect()
        };
        a.on_json(&delta("Hi ", 0, false));
        // Offsets count UTF-16 code units: the emoji is two.
        a.on_json(&delta("\u{1F600}", 3, false));
        a.on_json(&delta("!", 5, false));
        assert_eq!(texts(&mut rx), vec!["Hi ", "\u{1F600}", "!"]);
        // A gap: not delivered, the block is asked for, once.
        a.on_json(&delta("lost", 9, false));
        a.on_json(&delta("more", 13, false));
        assert!(texts(&mut rx).is_empty());
        assert_eq!(frames(&mut sent), vec![json!({"t": "block", "session": "cs_a", "blockId": "b1"})]);
        // The whole block replaces the copy; the consumer gets the rest.
        a.on_json(&delta("Hi \u{1F600}! and lostmore", 0, true));
        assert_eq!(texts(&mut rx), vec![" and lostmore"]);
        assert_eq!(a.watches["cs_a"].blocks["b1"].text, "Hi \u{1F600}! and lostmore");
        a.on_json(&delta(".", 19, false));
        assert_eq!(texts(&mut rx), vec!["."]);
        // A whole delta is never answered with `block`.
        assert!(frames(&mut sent).is_empty());
        // Deltas without a block pass as they come.
        a.on_json(&json!({"t": "delta", "session": "cs_a", "type": "tool.delta", "turnId": "tn_1", "data": {"callId": "c", "text": "x"}, "offset": 7}));
        assert_eq!(texts(&mut rx), vec!["x"]);
    }

    #[tokio::test]
    async fn detached_and_lost_reads_end_the_watch() {
        let (mut a, mut rx, _sent) = actor(&[("cs_a", From::Start), ("cs_b", From::Start)]);
        a.on_json(&json!({"t": "detached", "stream": "events:cs_a", "reason": "forbidden"}));
        assert!(matches!(&drain(&mut rx)[..], [WireEvent::Detached { reason, .. }] if reason == "forbidden"));
        a.on_page("cs_b", Err(Error::from_api(404, &json!({"error": {"code": "session_not_found", "message": "gone"}}))));
        assert!(matches!(&drain(&mut rx)[..], [WireEvent::Detached { reason, .. }] if reason == "session_not_found"));
        assert!(a.watches.is_empty());
    }
}
