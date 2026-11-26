//! Following sessions over the connection, for the commands that wait:
//! `opc -p`, `send --wait`, `wait` and `watch`.
//!
//! [`Follower`] turns the wire's stream into [`Step`]s and keeps a small
//! [`SessionState`] per session: the running and queued turns, the open asks
//! and the subagents. A [`Tracker`] decides from that state when a goal is
//! done (a turn ended or waits for a person, or the session settled), takes
//! the actions `--on-ask` asks for, and follows a steered message to the turn
//! it actually ran in.

use crate::api::result;
use crate::api::types::{Delta, Event, Subagent, is_ended_status};
use crate::cli::OnAsk;
use crate::error::{Error, Result};
use crate::wire::{AttachInfo, WireEvent, WireHandle};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::time::{Duration, Instant};
use tokio::sync::mpsc::UnboundedReceiver;

/// The message an `--on-ask dismiss` leaves for the agent.
pub const UNATTENDED: &str = "running unattended";
/// How long a steered message may take to show up as a turn of its own after
/// the turn it was steered into ended without reading it.
const REHOME_GRACE: Duration = Duration::from_secs(5);
const TICK: Duration = Duration::from_millis(250);

/// What one turn of the pump produced. The session's state is already
/// updated when a step is returned.
#[derive(Debug)]
pub enum Step {
    Connected { reconnect: bool },
    Reconnecting { attempt: u32, retry_in: Duration, error: Error },
    Attached(String),
    AttachFailed(String, Error),
    Event(Event),
    Delta(Delta),
    /// The log was rewritten from this `seq`; the state was reloaded.
    Reset(String),
    Detached(String, String),
    /// Nothing happened for a moment (for time-based checks).
    Tick,
}

impl Step {
    pub fn session_id(&self) -> Option<&str> {
        match self {
            Step::Attached(s) | Step::AttachFailed(s, _) | Step::Reset(s) | Step::Detached(s, _) => Some(s),
            Step::Event(e) => Some(e.session_id()),
            Step::Delta(d) => Some(d.session_id()),
            _ => None,
        }
    }
}

/// What is known of one session, from its attach snapshot and its events.
#[derive(Debug, Default)]
pub struct SessionState {
    pub id: String,
    pub attached: bool,
    /// The snapshot from the first attach.
    pub info: Option<Box<AttachInfo>>,
    /// Every event since `seq` 1 was seen, so the subagents are complete.
    pub from_start: bool,
    pub status: String,
    pub active: Option<String>,
    pub queued: Vec<String>,
    /// Open asks, in the order they opened.
    pub asks: Vec<Value>,
    /// Every subagent seen, in the order they started.
    pub subagents: Vec<Subagent>,
    /// Turns seen ending: id → (status, seq of the end).
    pub ended: HashMap<String, (String, u64)>,
    /// The last turn seen ending, or the session's last turn at attach.
    pub last_ended: Option<String>,
    /// Turns that carry a message (`message.received`); others started on
    /// their own or from a steered message that was not read.
    pub received: HashSet<String>,
    /// Turns known to exist, with their trigger.
    pub triggers: HashMap<String, Option<String>>,
    pub last_seq: u64,
    /// Attached a second time after `session_not_found`.
    pub reattached: bool,
}

impl SessionState {
    fn new(id: &str, from_start: bool) -> Self {
        SessionState { id: id.to_string(), from_start, ..Default::default() }
    }

    fn apply_snapshot(&mut self, info: &AttachInfo) {
        let s = &info.session;
        self.status = s.status.clone();
        self.active = s.active_turn_id.clone();
        self.queued = s.queued.iter().map(|t| t.id.clone()).collect();
        self.asks = s.asks.iter().filter(|a| a.is_open()).filter_map(|a| serde_json::to_value(a).ok()).collect();
        for sa in &s.subagents {
            self.upsert_subagent(sa.clone());
        }
        if let Some(last) = &s.last_turn
            && is_ended_status(&last.status)
        {
            self.ended.entry(last.id.clone()).or_insert((last.status.clone(), s.last_seq));
            if self.last_ended.is_none() {
                self.last_ended = Some(last.id.clone());
            }
        }
        self.last_seq = self.last_seq.max(s.last_seq);
    }

    fn upsert_subagent(&mut self, sa: Subagent) {
        match self.subagents.iter_mut().find(|s| s.id == sa.id) {
            // An ended subagent never runs again, whatever order things came in.
            Some(cur) if !cur.is_running() && sa.is_running() => {}
            Some(cur) => *cur = sa,
            None => self.subagents.push(sa),
        }
    }

    pub fn apply_event(&mut self, e: &Event) {
        self.last_seq = self.last_seq.max(e.seq());
        let turn = e.turn_id().map(str::to_string);
        let d = e.data();
        match e.kind() {
            "message.received" => {
                if let Some(t) = turn {
                    self.received.insert(t);
                }
            }
            "turn.queued" => {
                if let Some(t) = turn
                    && !self.ended.contains_key(&t)
                    && !self.queued.contains(&t)
                {
                    self.queued.push(t);
                }
            }
            "turn.started" => {
                if let Some(t) = turn {
                    self.queued.retain(|q| *q != t);
                    self.triggers.insert(t.clone(), d.get("trigger").and_then(Value::as_str).map(str::to_string));
                    if !self.ended.contains_key(&t) {
                        self.active = Some(t);
                    }
                }
            }
            "turn.completed" | "turn.failed" | "turn.cancelled" => {
                if let Some(t) = turn {
                    let status = e.kind().trim_start_matches("turn.").to_string();
                    self.queued.retain(|q| *q != t);
                    if self.active.as_deref() == Some(&t) {
                        self.active = None;
                    }
                    self.asks.retain(|a| a.get("turnId").and_then(Value::as_str) != Some(&t));
                    self.ended.insert(t.clone(), (status, e.seq()));
                    self.last_ended = Some(t);
                }
            }
            "session.status_changed" => {
                if let Some(to) = d.get("to").and_then(Value::as_str) {
                    self.status = to.to_string();
                }
            }
            "ask.opened" => {
                if let Some(ask) = d.get("ask") {
                    let id = ask.get("id").cloned();
                    self.asks.retain(|a| a.get("id") != id.as_ref());
                    self.asks.push(ask.clone());
                }
            }
            "ask.closed" => {
                let id = d.pointer("/ask/id").cloned();
                self.asks.retain(|a| a.get("id") != id.as_ref());
            }
            "subagent.started" | "subagent.ended" => {
                if let Some(sa) = d.get("subagent").and_then(|v| serde_json::from_value::<Subagent>(v.clone()).ok()) {
                    self.upsert_subagent(sa);
                }
            }
            _ => {}
        }
    }

    pub fn apply_delta(&mut self, d: &Delta) {
        if d.kind() == "subagent.progress"
            && let Some(id) = d.data().get("subagentId").and_then(Value::as_str)
            && let Some(sa) = self.subagents.iter_mut().find(|s| s.id == id)
            && sa.is_running()
        {
            sa.apply_progress(d.data());
        }
    }

    /// No turn running or queued.
    pub fn settled(&self) -> bool {
        self.active.is_none() && self.queued.is_empty()
    }

    pub fn turn_ended(&self, turn: &str) -> bool {
        self.ended.contains_key(turn)
    }

    /// The subagents a turn started.
    pub fn subagents_of(&self, turn: &str) -> Vec<Subagent> {
        self.subagents.iter().filter(|s| s.turn_id.as_deref() == Some(turn)).cloned().collect()
    }

    pub fn running_subagents_of(&self, turn: &str) -> usize {
        self.subagents.iter().filter(|s| s.turn_id.as_deref() == Some(turn) && s.is_running()).count()
    }

    /// The open ask that blocks this turn, if any.
    pub fn ask_for(&self, turn: &str) -> Option<&Value> {
        self.asks.iter().find(|a| a.get("turnId").and_then(Value::as_str).is_none_or(|t| t == turn))
    }
}

pub struct Follower {
    pub wire: WireHandle,
    rx: UnboundedReceiver<WireEvent>,
    pub states: HashMap<String, SessionState>,
    connected_once: bool,
}

impl Follower {
    /// `from_start`: the sessions were attached with `after: 0`.
    pub fn new(wire: WireHandle, rx: UnboundedReceiver<WireEvent>, sessions: &[(String, bool)]) -> Follower {
        let states = sessions.iter().map(|(id, from_start)| (id.clone(), SessionState::new(id, *from_start))).collect();
        Follower { wire, rx, states, connected_once: false }
    }

    pub fn state(&self, id: &str) -> Option<&SessionState> {
        self.states.get(id)
    }

    /// Follows one more session over the same connection.
    pub fn attach(&mut self, attach: crate::wire::Attach) {
        let from_start = attach.after == Some(0);
        self.states.entry(attach.session_id.clone()).or_insert_with(|| SessionState::new(&attach.session_id, from_start));
        self.wire.attach(attach);
    }

    pub fn forget(&mut self, id: &str) {
        self.states.remove(id);
        self.wire.detach(id);
    }

    /// The next step. A failure the connection cannot recover from is an
    /// error.
    pub async fn next(&mut self) -> Result<Step> {
        let ev = match tokio::time::timeout(TICK, self.rx.recv()).await {
            Err(_) => return Ok(Step::Tick),
            Ok(None) => return Err(Error::unreachable("the connection to your computer closed")),
            Ok(Some(ev)) => ev,
        };
        Ok(match ev {
            WireEvent::Connected { took, resumed_tls, reconnect, .. } => {
                if !self.connected_once {
                    crate::timing::get().mark_connect(took, resumed_tls);
                    self.connected_once = true;
                }
                Step::Connected { reconnect }
            }
            WireEvent::Attached { session_id, result } => match result {
                Ok(info) => {
                    let st = self.states.entry(session_id.clone()).or_insert_with(|| SessionState::new(&session_id, false));
                    if st.info.is_none() {
                        st.apply_snapshot(&info);
                        st.info = Some(info);
                    }
                    st.attached = true;
                    crate::timing::get().mark_ready();
                    Step::Attached(session_id)
                }
                Err(e) => Step::AttachFailed(session_id, e),
            },
            WireEvent::Event(e) => {
                crate::telemetry::print_step(e.turn_id(), e.kind());
                if let Some(st) = self.states.get_mut(e.session_id()) {
                    st.apply_event(&e);
                }
                Step::Event(e)
            }
            WireEvent::Delta(d) => {
                crate::telemetry::print_step(d.turn_id(), d.kind());
                if let Some(st) = self.states.get_mut(d.session_id()) {
                    st.apply_delta(&d);
                }
                Step::Delta(d)
            }
            WireEvent::EpochReset { session_id, .. } => {
                // State derived from the rewritten events cannot be undone
                // piece by piece: start again from the session as it is.
                let got = self.wire.call("sessions.get", json!({"sessionId": session_id})).await?;
                let info = crate::wire::reconnect::parse_attach(&got)?;
                let from_start = self.states.get(&session_id).is_some_and(|s| s.from_start);
                let mut st = SessionState::new(&session_id, from_start);
                st.apply_snapshot(&info);
                st.info = Some(Box::new(info));
                st.attached = true;
                self.states.insert(session_id.clone(), st);
                Step::Reset(session_id)
            }
            WireEvent::Detached { session_id, reason } => Step::Detached(session_id, reason),
            WireEvent::Reconnecting { attempt, retry_in, error } => Step::Reconnecting { attempt, retry_in, error },
            WireEvent::Fatal(e) => return Err(e),
            WireEvent::TerminalExited(_) | WireEvent::Binary { .. } => Step::Tick,
        })
    }

    /// A turn as the server has it, once it includes `min_seq`.
    pub async fn get_turn(&self, session_id: &str, turn_id: &str, min_seq: Option<u64>) -> Result<Value> {
        let mut p = json!({"sessionId": session_id, "turnId": turn_id});
        if let Some(s) = min_seq.filter(|s| *s > 0) {
            p["minSeq"] = json!(s);
        }
        let got = self.wire.call("turns.get", p).await?;
        Ok(got.get("turn").cloned().unwrap_or(Value::Null))
    }

    /// The Result for a finished goal.
    pub async fn result(&self, session_id: &str, done: &Done, url: &str) -> Result<Option<Value>> {
        let Some(turn_id) = &done.turn_id else { return Ok(None) };
        let st = self.states.get(session_id);
        let end_seq = st.and_then(|s| s.ended.get(turn_id)).map(|(_, seq)| *seq);
        let complete = st.is_some_and(|s| s.from_start);
        let turn_f = self.get_turn(session_id, turn_id, end_seq);
        let list_f = async {
            if complete {
                return Ok(Vec::new());
            }
            let got = self.wire.call("subagents.list", json!({"sessionId": session_id, "status": "all", "limit": 100})).await?;
            Ok::<_, Error>(
                got.get("subagents")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().filter_map(|v| serde_json::from_value::<Subagent>(v.clone()).ok()).collect())
                    .unwrap_or_default(),
            )
        };
        let (turn, listed) = tokio::join!(turn_f, list_f);
        let turn = turn?;
        let mut subagents = st.map(|s| s.subagents_of(turn_id)).unwrap_or_default();
        // The list is a fallback for subagents that started before we attached;
        // what the events said is newer.
        for sa in listed.unwrap_or_default() {
            if sa.turn_id.as_deref() == Some(turn_id.as_str()) && !subagents.iter().any(|s| s.id == sa.id) {
                subagents.push(sa);
            }
        }
        subagents.sort_by(|a, b| a.created_at.cmp(&b.created_at));
        // A turn that waits is reported as waiting only while it has not ended.
        let ask = if turn.get("status").and_then(Value::as_str).is_some_and(is_ended_status) { None } else { done.ask.as_ref() };
        Ok(Some(result::build(&turn, session_id, url, ask, &subagents)))
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Goal {
    /// This turn ends, or waits for a person.
    Turn(String),
    /// No turn running or queued, or one waits for a person.
    Settled,
}

/// A finished goal: the turn to report, and the open ask when it waits.
#[derive(Debug, Clone, Default)]
pub struct Done {
    pub turn_id: Option<String>,
    pub ask: Option<Value>,
}

impl Done {
    pub fn waiting(&self) -> bool {
        self.ask.is_some()
    }
}

/// Waits for one goal in one session.
#[derive(Debug)]
pub struct Tracker {
    pub session_id: String,
    pub goal: Goal,
    pub on_ask: OnAsk,
    pub wait_subagents: bool,
    /// The message, when it was steered or held into a running turn: if that
    /// turn ends without reading it, it runs as a turn of its own.
    steered: Option<String>,
    /// The turn the steered message was meant for ended without it, at this
    /// moment: look for the turn it started.
    rehoming: Option<(String, Instant)>,
    /// The send's `seq`: a snapshot at or past it already includes the turn.
    sent_seq: u64,
    checked_attach: bool,
    dismissed: HashSet<String>,
    pub done: Option<Done>,
    /// Why this session could not be followed (with `done` set), when the
    /// command follows others too.
    pub failed: Option<Error>,
}

impl Tracker {
    pub fn new(session_id: &str, goal: Goal, on_ask: OnAsk, wait_subagents: bool) -> Tracker {
        Tracker {
            session_id: session_id.to_string(),
            goal,
            on_ask,
            wait_subagents,
            steered: None,
            rehoming: None,
            sent_seq: 0,
            checked_attach: false,
            dismissed: HashSet::new(),
            done: None,
            failed: None,
        }
    }

    /// For a message sent with `steered` or `held` delivery.
    pub fn steered(mut self, input: Option<String>) -> Tracker {
        self.steered = input;
        self
    }

    pub fn sent_seq(mut self, seq: u64) -> Tracker {
        self.sent_seq = seq;
        self
    }

    /// The turn this tracker reports on now.
    pub fn turn(&self) -> Option<&str> {
        match &self.goal {
            Goal::Turn(t) => Some(t),
            Goal::Settled => None,
        }
    }

    /// Looks at the state after a step, takes the actions it calls for, and
    /// sets `done` when the goal is reached.
    pub async fn update(&mut self, f: &mut Follower, step: &Step) -> Result<()> {
        if self.done.is_some() {
            return Ok(());
        }
        if step.session_id().is_some_and(|s| s != self.session_id) && !matches!(step, Step::Tick) {
            return Ok(());
        }
        let Some(st) = f.states.get(&self.session_id) else { return Ok(()) };
        if !st.attached {
            return Ok(());
        }
        match self.goal.clone() {
            Goal::Turn(turn) => self.update_turn(f, step, &turn).await,
            Goal::Settled => self.update_settled(f).await,
        }
    }

    async fn update_turn(&mut self, f: &mut Follower, step: &Step, turn: &str) -> Result<()> {
        let sid = self.session_id.clone();
        // A steered message that its turn did not read: the next turn without
        // a message of its own, carrying our input, is where it ran.
        if let Some((from, since)) = self.rehoming.clone() {
            if let Step::Event(e) = step
                && matches!(e.kind(), "turn.queued" | "turn.started")
                && let Some(t) = e.turn_id()
                && t != from
                && !f.states[&sid].received.contains(t)
            {
                let got = f.get_turn(&sid, t, Some(e.seq())).await?;
                if got.get("input").and_then(Value::as_str) == self.steered.as_deref() {
                    crate::log::debug(&format!("the steered message ran as {t}"));
                    self.goal = Goal::Turn(t.to_string());
                    self.rehoming = None;
                    self.steered = None;
                    return Box::pin(self.update_turn(f, &Step::Tick, t)).await;
                }
            }
            if since.elapsed() >= REHOME_GRACE {
                self.rehoming = None;
                self.steered = None;
            } else {
                return Ok(());
            }
        }

        let st = &f.states[&sid];
        if !self.checked_attach {
            self.checked_attach = true;
            // The turn may have ended before we attached.
            let known = st.active.as_deref() == Some(turn) || st.queued.iter().any(|q| q == turn) || st.turn_ended(turn);
            let snapshot_seq = st.info.as_ref().map(|i| i.session.last_seq).unwrap_or(0);
            if !known && snapshot_seq >= self.sent_seq {
                let got = f.get_turn(&sid, turn, None).await?;
                let status = got.get("status").and_then(Value::as_str).unwrap_or("").to_string();
                if is_ended_status(&status)
                    && let Some(st) = f.states.get_mut(&sid)
                {
                    st.ended.insert(turn.to_string(), (status, 0));
                }
            }
        }

        let st = &f.states[&sid];
        if st.turn_ended(turn) {
            if let Some(input) = self.steered.clone() {
                let got = f.get_turn(&sid, turn, st.ended.get(turn).map(|e| e.1)).await?;
                let read = got
                    .get("steering")
                    .and_then(Value::as_array)
                    .is_some_and(|s| s.iter().any(|m| m.get("input").and_then(Value::as_str) == Some(&input)));
                if read || got.get("input").and_then(Value::as_str) == Some(&input) {
                    self.steered = None;
                } else {
                    self.rehoming = Some((turn.to_string(), Instant::now()));
                    return Ok(());
                }
            }
            let st = &f.states[&sid];
            if self.wait_subagents && st.running_subagents_of(turn) > 0 {
                return Ok(());
            }
            self.done = Some(Done { turn_id: Some(turn.to_string()), ask: None });
            return Ok(());
        }
        if let Some(ask) = st.ask_for(turn).cloned()
            && (st.active.as_deref() == Some(turn) || st.active.is_none())
        {
            self.on_open_ask(f, Some(turn.to_string()), ask).await?;
        }
        Ok(())
    }

    async fn update_settled(&mut self, f: &mut Follower) -> Result<()> {
        let st = &f.states[&self.session_id];
        if let Some(active) = st.active.clone()
            && let Some(ask) = st.ask_for(&active).cloned()
        {
            return self.on_open_ask(f, Some(active), ask).await;
        }
        if !st.settled() {
            return Ok(());
        }
        let last = st.last_ended.clone();
        if self.wait_subagents
            && let Some(t) = &last
            && st.running_subagents_of(t) > 0
        {
            return Ok(());
        }
        self.done = Some(Done { turn_id: last, ask: None });
        Ok(())
    }

    async fn on_open_ask(&mut self, f: &mut Follower, turn: Option<String>, ask: Value) -> Result<()> {
        let ask_id = ask.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        match self.on_ask {
            OnAsk::Fail => {
                self.done = Some(Done { turn_id: turn, ask: Some(ask) });
            }
            OnAsk::Wait => {}
            OnAsk::Dismiss => {
                if self.dismissed.insert(ask_id.clone()) {
                    let r = f
                        .wire
                        .call("asks.dismiss", json!({"sessionId": self.session_id, "askId": ask_id, "message": UNATTENDED}))
                        .await;
                    match r {
                        Ok(_) => {}
                        // Someone else closed it first: carry on.
                        Err(e) if matches!(e.code.as_str(), "ask_closed" | "ask_not_found") => {}
                        Err(e) => return Err(e),
                    }
                }
            }
        }
        Ok(())
    }
}

/// Whether a reconnect is worth a line on stderr: the first few retries
/// (0, ~250 and ~500 ms) usually succeed within a second and stay quiet.
pub fn worth_saying(attempt: u32, retry_in: std::time::Duration) -> bool {
    attempt >= 3 || retry_in >= std::time::Duration::from_secs(1)
}

/// The error for `session.detached` with this reason.
pub fn detached_error(sid: &str, reason: &str) -> Error {
    let code = if reason.contains("archived") || reason.contains("deleted") || reason.contains("not_found") { "session_not_found" } else { "forbidden" };
    Error::new(code, format!("stopped receiving {sid}: {reason}")).with("sessionId", sid).with("reason", reason)
}

/// Pumps steps into `sink` and the trackers until one that was not done is
/// done; returns its index. `sink` sees every step first.
pub async fn run_until_next(
    f: &mut Follower,
    trackers: &mut [Tracker],
    sink: &mut (dyn FnMut(&Follower, &Step) + Send),
) -> Result<usize> {
    let before: Vec<bool> = trackers.iter().map(|t| t.done.is_some()).collect();
    // Goals already reached by what is known.
    for t in trackers.iter_mut() {
        t.update(f, &Step::Tick).await?;
    }
    loop {
        if let Some(i) = trackers.iter().enumerate().position(|(i, t)| t.done.is_some() && !before[i]) {
            return Ok(i);
        }
        let step = f.next().await?;
        if let Step::AttachFailed(sid, e) = &step
            && trackers.iter().any(|t| &t.session_id == sid)
        {
            // A session this command just created can be attached before
            // the server has it (a slow or retried create): try once more.
            if e.code == "session_not_found"
                && let Some(st) = f.states.get_mut(sid)
                && st.from_start
                && !st.reattached
            {
                st.reattached = true;
                f.wire.attach(crate::wire::Attach { session_id: sid.clone(), after: Some(0), ..Default::default() });
                continue;
            }
        }
        let lost = match &step {
            Step::AttachFailed(sid, e) => Some((sid.clone(), e.clone())),
            Step::Detached(sid, reason) => Some((sid.clone(), detached_error(sid, reason))),
            _ => None,
        };
        if let Some((sid, e)) = lost.filter(|(sid, _)| trackers.iter().any(|t| &t.session_id == sid && t.done.is_none())) {
            // One session lost ends the command only when it is the only
            // one left: the others still get their Results.
            if trackers.len() == 1 {
                return Err(e);
            }
            for t in trackers.iter_mut().filter(|t| t.session_id == sid && t.done.is_none()) {
                t.failed = Some(e.clone());
                t.done = Some(Done::default());
            }
            continue;
        }
        sink(f, &step);
        for t in trackers.iter_mut() {
            t.update(f, &step).await?;
        }
    }
}
