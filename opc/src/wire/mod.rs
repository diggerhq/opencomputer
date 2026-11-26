//! The two sockets: the live socket (`GET /live` on the API, protocol
//! `oc.live.v1`) that watches sessions ([`Live`], `live.rs`), and the
//! WebSocket to the computer (`wss://wire.opencomputer.dev/v1`, protocol
//! `opc.v1`, JSON-RPC 2.0) for terminals and telemetry ([`Wire`],
//! `reconnect.rs`). Watching never needs the wire: a command dials it only
//! for what only the computer can do.
//!
//! Both open at once and report on a stream of [`WireEvent`]s; the dials run
//! in the background. The stream carries every recorded event once and in
//! `seq` order per session, across reconnects: `live.rs` holds each
//! session's opaque cursor, reads over HTTP whenever a pushed range does not
//! start at it, and applies `reset`.

pub mod client;
pub mod live;
pub mod reconnect;
pub mod redial;

use crate::api::types::{Capabilities, Delta, Event, Session, Turn};
use crate::error::Error;
use bytes::Bytes;
use serde_json::Value;
use std::time::Duration;

pub use live::Live;
pub use reconnect::{Wire, WireHandle};

/// WebSocket subprotocol.
pub const PROTOCOL: &str = "opc.v1";

#[derive(Debug, Clone)]
pub struct WireOptions {
    /// `wss://wire.opencomputer.dev/v1`
    pub url: String,
    pub key: String,
    /// Give up with `unreachable` after this long continuously disconnected
    /// (non-interactive commands); `None` keeps trying (the screen).
    pub give_up: Option<Duration>,
}

/// Where a session's events start.
#[derive(Debug, Clone, Default, PartialEq)]
pub enum From {
    /// Only what is recorded from now on.
    #[default]
    Now,
    /// The whole log.
    Start,
    /// The last `n` turns in full (1 to 50), earlier ones summarized.
    Tail(u32),
    /// After this cursor, an opaque string the server made. The `seq` is the
    /// last event the caller holds, when it holds any.
    Cursor(String, Option<u64>),
}

/// A session to watch.
#[derive(Debug, Clone, Default)]
pub struct Attach {
    pub session_id: String,
    pub from: From,
}

/// The session as it is when watching starts.
#[derive(Debug, Clone)]
pub struct AttachInfo {
    pub session: Session,
    pub capabilities: Option<Capabilities>,
    pub earlier_turns: Option<Vec<Turn>>,
}

#[derive(Debug, Clone)]
pub enum WireEvent {
    /// A connection is open (`ready` arrived). `took` is from the dial to now.
    Connected { connection_id: String, region: Option<String>, took: Duration, resumed_tls: bool, reconnect: bool },
    /// A session is attached, or failed to.
    Attached { session_id: String, result: Result<Box<AttachInfo>, Error> },
    /// A recorded event: exactly once, in order.
    Event(Event),
    /// A streamed delta.
    Delta(Delta),
    /// The cursor after the events delivered so far: what to keep with them
    /// to start from here another time. Compare for equality only. `head`:
    /// it was the end of the log when it was read.
    Cursor { session_id: String, cursor: String, head: bool },
    /// The server answered `reset`: the position read from no longer exists.
    /// Drop every event with a `seq` above `seq` (all of them when it is
    /// `None`); the events after it follow, read from `cursor`.
    Reset { session_id: String, seq: Option<u64>, cursor: Option<String> },
    /// The server stopped sending this session (`forbidden`, `gone`).
    Detached { session_id: String, reason: String },
    /// A terminal ended: `{terminalId, exitCode, signal}`.
    TerminalExited(Value),
    /// Terminal output, by channel.
    Binary { channel: u32, data: Bytes },
    /// The connection dropped; the next attempt is in `retry_in`.
    Reconnecting { attempt: u32, retry_in: Duration, error: Error },
    /// A failure reconnecting cannot fix (revoked key, old protocol).
    Fatal(Error),
}
