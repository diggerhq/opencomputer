//! The WebSocket to the computer: `wss://wire.opencomputer.dev/v1`, protocol
//! `opc.v1`, JSON-RPC 2.0, the first attach in the upgrade URL.
//!
//! [`Wire::open`] returns at once with a handle and a stream of
//! [`WireEvent`]s; the dial runs in the background. The stream carries every
//! recorded event exactly once and in `seq` order per session, across
//! reconnects (`reconnect.rs` keeps the cursors, skips repeats, refills gaps
//! and applies the `logEpoch` rule).

pub mod client;
pub mod reconnect;

use crate::api::types::{Capabilities, Delta, Event, Session, Turn};
use crate::error::Error;
use bytes::Bytes;
use serde_json::Value;
use std::time::Duration;

pub use reconnect::{Wire, WireHandle};

/// WebSocket subprotocol.
pub const PROTOCOL: &str = "opc.v1";

#[derive(Debug, Clone)]
pub struct WireOptions {
    /// `wss://wire.opencomputer.dev/v1`
    pub url: String,
    pub key: String,
    /// Ask for deltas on every session.
    pub deltas: bool,
    /// Resume suspended sessions when attaching (only the interactive screen).
    pub resume: bool,
    /// Attach read-only (`opc a --read-only`).
    pub read_only: bool,
    /// Give up with `unreachable` after this long continuously disconnected
    /// (non-interactive commands); `None` keeps trying (the screen).
    pub give_up: Option<Duration>,
}

/// Where to start a session's events.
#[derive(Debug, Clone, Default)]
pub struct Attach {
    pub session_id: String,
    /// Recorded events after this `seq`, then live ones.
    pub after: Option<u64>,
    /// Without `after`: the last `n` turns in full, earlier ones summarized.
    pub tail_turns: Option<u32>,
    /// The `logEpoch` the caller's cache holds, for the epoch check.
    pub log_epoch: Option<u64>,
}

/// What `sessions.attach` returned, or `sessions.attached` carried.
#[derive(Debug, Clone)]
pub struct AttachInfo {
    pub session: Session,
    pub log_epoch: u64,
    pub epoch_start_seq: u64,
    pub capabilities: Option<Capabilities>,
    pub earlier_turns: Option<Vec<Turn>>,
    pub server: Option<Duration>,
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
    /// The log was rewritten from `epoch_start_seq` (a computer was lost
    /// mid-turn): drop what you applied at or after it. The replacement
    /// events follow.
    EpochReset { session_id: String, epoch_start_seq: u64 },
    /// The server stopped sending this session (`access_lost`).
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
