//! What `opc` keeps on this machine, under `OPC_STATE_DIR`
//! (`~/.opencomputer/opc`):
//!
//! - `state.json`: the last session, turns sent from here (for `opc wait
//!   tn_…`), the wire URL from `/me`;
//! - `sessions.json`: the last session list, so `ls`, the picker and prefix
//!   resolution answer before the network;
//! - `sessions/<id>.jsonl`: a session's recorded events, `0600`; the first
//!   line is a header with the `logEpoch` they belong to;
//! - `history`: the prompt line's history.
//!
//! Every file is replaced atomically or appended under a file lock, so any
//! number of `opc` processes can share them. Every read tolerates a missing
//! or damaged file: the cache only ever saves a fetch.

use crate::api::types::{Event, Session};
use crate::config::{create_private_dir, state_dir, write_private, write_private_json};
use crate::error::Result;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};

/// Turns remembered for `opc wait tn_…` alone.
const MAX_TURNS: usize = 500;
/// The prompt line's history.
pub const MAX_HISTORY: usize = 10_000;

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct State {
    pub last_session: Option<String>,
    /// turn id → session id, newest last.
    pub turns: Vec<(String, String)>,
    /// From `GET /me`, keyed by API URL.
    pub wire_urls: BTreeMap<String, String>,
    #[serde(flatten)]
    pub other: serde_json::Map<String, Value>,
}

fn dir() -> PathBuf {
    state_dir()
}

fn lock_file() -> Option<File> {
    let d = dir();
    create_private_dir(&d).ok()?;
    let f = OpenOptions::new().create(true).truncate(false).write(true).open(d.join(".lock")).ok()?;
    f.lock().ok()?;
    Some(f)
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> T {
    std::fs::read(path).ok().and_then(|b| serde_json::from_slice(&b).ok()).unwrap_or_default()
}

pub fn load_state() -> State {
    read_json(&dir().join("state.json"))
}

/// Read, change and write `state.json` under the lock.
pub fn update_state(f: impl FnOnce(&mut State)) -> Result<()> {
    let _lock = lock_file();
    let path = dir().join("state.json");
    let mut s: State = read_json(&path);
    f(&mut s);
    write_private_json(&path, &serde_json::to_value(&s)?)
}

pub fn set_last_session(id: &str) {
    let _ = update_state(|s| s.last_session = Some(id.to_string()));
}

pub fn remember_turn(turn_id: &str, session_id: &str) {
    let _ = update_state(|s| {
        s.last_session = Some(session_id.to_string());
        s.turns.retain(|(t, _)| t != turn_id);
        s.turns.push((turn_id.to_string(), session_id.to_string()));
        if s.turns.len() > MAX_TURNS {
            let n = s.turns.len() - MAX_TURNS;
            s.turns.drain(..n);
        }
    });
}

pub fn session_for_turn(turn_id: &str) -> Option<String> {
    load_state().turns.into_iter().rev().find(|(t, _)| t == turn_id).map(|(_, s)| s)
}

pub fn wire_url(api_url: &str) -> Option<String> {
    load_state().wire_urls.get(api_url).cloned()
}

pub fn set_wire_url(api_url: &str, url: &str) {
    if wire_url(api_url).as_deref() == Some(url) {
        return;
    }
    let _ = update_state(|s| {
        s.wire_urls.insert(api_url.to_string(), url.to_string());
    });
}

// ---- sessions.json ----

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
struct SessionList {
    api_url: String,
    sessions: Vec<Session>,
}

/// The cached session list for this API, newest activity first.
pub fn sessions(api_url: &str) -> Vec<Session> {
    let l: SessionList = read_json(&dir().join("sessions.json"));
    if l.api_url == api_url { l.sessions } else { Vec::new() }
}

pub fn save_sessions(api_url: &str, sessions: &[Session]) {
    let _lock = lock_file();
    let l = SessionList { api_url: api_url.to_string(), sessions: sessions.to_vec() };
    if let Ok(v) = serde_json::to_value(&l) {
        let _ = write_private(&dir().join("sessions.json"), v.to_string().as_bytes());
    }
}

/// Puts one session at the front of the cached list (created, attached).
pub fn upsert_session(api_url: &str, session: &Session) {
    let mut list = sessions(api_url);
    list.retain(|s| s.id != session.id);
    list.insert(0, session.clone());
    list.truncate(500);
    save_sessions(api_url, &list);
}

// ---- sessions/<id>.jsonl ----

fn events_path(session_id: &str) -> Option<PathBuf> {
    // Ids are validated before they reach the file system.
    crate::ids::is_session_id(session_id).then(|| dir().join("sessions").join(format!("{session_id}.jsonl")))
}

/// A session's cached events and the `logEpoch` they belong to.
#[derive(Debug, Clone, Default)]
pub struct CachedLog {
    pub log_epoch: Option<u64>,
    pub events: Vec<Event>,
}

impl CachedLog {
    pub fn last_seq(&self) -> Option<u64> {
        self.events.last().map(Event::seq)
    }
}

/// Reads the cache. Lines that do not parse, or break the `seq` order, end it.
pub fn load_events(session_id: &str) -> CachedLog {
    let Some(path) = events_path(session_id) else { return CachedLog::default() };
    let Ok(f) = File::open(&path) else { return CachedLog::default() };
    let _ = f.lock_shared();
    let mut out = CachedLog::default();
    let mut last = 0u64;
    for (i, line) in BufReader::new(&f).lines().enumerate() {
        let Ok(line) = line else { break };
        let Ok(v) = serde_json::from_str::<Value>(&line) else { break };
        if i == 0 && v.get("type").and_then(Value::as_str) == Some("opc.cache") {
            out.log_epoch = v.get("logEpoch").and_then(Value::as_u64);
            continue;
        }
        let ev = Event(v);
        let seq = ev.seq();
        if seq <= last {
            break;
        }
        last = seq;
        out.events.push(ev);
    }
    let _ = f.unlock();
    out
}

/// Appends events, in order, after what the file holds. An event at or below
/// the file's last `seq` is skipped.
pub fn append_events(session_id: &str, log_epoch: u64, events: &[Event]) {
    if events.is_empty() {
        return;
    }
    let Some(path) = events_path(session_id) else { return };
    let _ = (|| -> std::io::Result<()> {
        if let Some(d) = path.parent() {
            create_private_dir(d).map_err(|e| std::io::Error::other(e.message))?;
        }
        let mut opts = OpenOptions::new();
        opts.create(true).append(true).read(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path)?;
        f.lock()?;
        let existing = {
            drop_lock_safe_read(&path)
        };
        let mut buf = Vec::new();
        let (epoch_ok, last) = match &existing {
            Some((epoch, last)) => (*epoch == Some(log_epoch), *last),
            None => (false, 0),
        };
        if !epoch_ok {
            // A new file, or another epoch: start over.
            f.set_len(0)?;
            buf.extend_from_slice(json!({"type": "opc.cache", "logEpoch": log_epoch}).to_string().as_bytes());
            buf.push(b'\n');
        }
        let mut last = if epoch_ok { last } else { 0 };
        for e in events {
            if e.seq() <= last {
                continue;
            }
            last = e.seq();
            serde_json::to_writer(&mut buf, &e.0)?;
            buf.push(b'\n');
        }
        f.write_all(&buf)?;
        f.unlock()
    })();
}

/// The header epoch and last `seq` of a cache file, read without locking
/// (the caller holds the lock).
fn drop_lock_safe_read(path: &Path) -> Option<(Option<u64>, u64)> {
    let f = File::open(path).ok()?;
    let mut epoch = None;
    let mut last = 0;
    let mut any = false;
    for (i, line) in BufReader::new(f).lines().enumerate() {
        let line = line.ok()?;
        let v: Value = serde_json::from_str(&line).ok()?;
        any = true;
        if i == 0 && v.get("type").and_then(Value::as_str) == Some("opc.cache") {
            epoch = v.get("logEpoch").and_then(Value::as_u64);
            continue;
        }
        last = v.get("seq").and_then(Value::as_u64).unwrap_or(last);
    }
    any.then_some((epoch, last))
}

/// Drops cached events at or after `from_seq` (the log was rewritten), and
/// records the new epoch.
pub fn truncate_events(session_id: &str, log_epoch: u64, from_seq: u64) {
    let cached = load_events(session_id);
    let keep: Vec<Event> = cached.events.into_iter().filter(|e| e.seq() < from_seq).collect();
    let Some(path) = events_path(session_id) else { return };
    let mut buf = Vec::new();
    buf.extend_from_slice(json!({"type": "opc.cache", "logEpoch": log_epoch}).to_string().as_bytes());
    buf.push(b'\n');
    for e in &keep {
        if serde_json::to_writer(&mut buf, &e.0).is_ok() {
            buf.push(b'\n');
        }
    }
    let _lock = lock_file();
    let _ = write_private(&path, &buf);
}

// ---- history ----

pub fn history() -> Vec<String> {
    let Ok(f) = File::open(dir().join("history")) else { return Vec::new() };
    BufReader::new(f)
        .lines()
        .map_while(|l| l.ok())
        .filter_map(|l| serde_json::from_str::<String>(&l).ok())
        .collect()
}

pub fn add_history(line: &str) {
    if line.trim().is_empty() {
        return;
    }
    let _lock = lock_file();
    let mut h = history();
    if h.last().map(String::as_str) == Some(line) {
        return;
    }
    h.push(line.to_string());
    if h.len() > MAX_HISTORY {
        let n = h.len() - MAX_HISTORY;
        h.drain(..n);
    }
    let mut buf = Vec::new();
    for l in &h {
        if serde_json::to_writer(&mut buf, l).is_ok() {
            buf.push(b'\n');
        }
    }
    let _ = write_private(&dir().join("history"), &buf);
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    static ENV: Mutex<()> = Mutex::new(());

    fn with_dir<R>(f: impl FnOnce() -> R) -> R {
        let _g = ENV.lock().unwrap_or_else(|e| e.into_inner());
        let d = std::env::temp_dir().join(format!("opc-cache-{}", crate::ids::random_base32(8)));
        // SAFETY: tests touching the environment hold ENV.
        unsafe { std::env::set_var("OPC_STATE_DIR", &d) };
        let r = f();
        let _ = std::fs::remove_dir_all(&d);
        r
    }

    fn ev(seq: u64) -> Event {
        Event(json!({"seq": seq, "type": "message.completed", "sessionId": "cs_0123456789abcdef"}))
    }

    #[test]
    fn events_append_in_order_and_reset_on_a_new_epoch() {
        with_dir(|| {
            let id = "cs_0123456789abcdef";
            append_events(id, 1, &[ev(1), ev(2)]);
            append_events(id, 1, &[ev(2), ev(3)]);
            let c = load_events(id);
            assert_eq!(c.log_epoch, Some(1));
            assert_eq!(c.events.iter().map(Event::seq).collect::<Vec<_>>(), vec![1, 2, 3]);
            truncate_events(id, 2, 3);
            let c = load_events(id);
            assert_eq!(c.log_epoch, Some(2));
            assert_eq!(c.last_seq(), Some(2));
            append_events(id, 3, &[ev(5)]);
            let c = load_events(id);
            assert_eq!(c.log_epoch, Some(3));
            assert_eq!(c.events.iter().map(Event::seq).collect::<Vec<_>>(), vec![5]);
        });
    }

    #[test]
    fn state_remembers_turns() {
        with_dir(|| {
            remember_turn("tn_0123456789ab", "cs_0123456789abcdef");
            assert_eq!(session_for_turn("tn_0123456789ab").as_deref(), Some("cs_0123456789abcdef"));
            assert_eq!(load_state().last_session.as_deref(), Some("cs_0123456789abcdef"));
        });
    }

    #[test]
    fn refuses_odd_ids() {
        assert!(events_path("../etc/passwd").is_none());
    }
}
