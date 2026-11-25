//! The fake's one model: sessions with their turns, asks and subagents, and a
//! single event log per session. Every change goes through [`Shared::with`],
//! which appends the events it causes (validated against the schema), sends
//! them to WebSocket connections in `seq` order, records any status change,
//! and wakes everything waiting (long polls, `minSeq`, attaches, scripts).

use super::schema::validate;
use super::{Knobs, LoggedRequest, WsFrame};
use serde_json::{Map, Value, json};
use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

pub const ALPHABET: &[u8] = b"0123456789abcdefghjkmnpqrstvwxyz";
pub const MAX_QUEUE: usize = 20;
pub const WINDOW_TOKENS: u64 = 200_000;

pub fn rand_str(n: usize) -> String {
    let mut buf = vec![0u8; n];
    getrandom::fill(&mut buf).expect("getrandom");
    buf.iter().map(|b| ALPHABET[(*b as usize) % 32] as char).collect()
}

pub fn new_id(prefix: &str) -> String {
    let n = match prefix {
        "cs_" | "ev_" => 16,
        _ => 12,
    };
    format!("{prefix}{}", rand_str(n))
}

/// ISO 8601, UTC, milliseconds.
pub fn now() -> String {
    let t = time::OffsetDateTime::now_utc();
    format!(
        "{:04}-{:02}-{:02}T{:02}:{:02}:{:02}.{:03}Z",
        t.year(),
        t.month() as u8,
        t.day(),
        t.hour(),
        t.minute(),
        t.second(),
        t.millisecond()
    )
}

pub fn now_ms() -> u128 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_millis()
}

pub fn me() -> Value {
    json!({"id": "usr_me7f3a9k2m4q", "name": "Test User", "email": "test@example.com"})
}

pub fn other_person() -> Value {
    json!({"id": "usr_other8q2x7c1", "name": "Other Person", "email": "other@example.com"})
}

pub fn actor_of(person: &Value, via: &str, client: Option<&str>) -> Value {
    json!({"id": person["id"], "name": person["name"], "via": via, "client": client})
}

pub fn capabilities() -> Value {
    json!({
        "models": [
            {"id": "opus-5.5", "name": "Opus 5.5", "efforts": ["low", "medium", "high", "xhigh", "max"], "contextWindow": WINDOW_TOKENS, "default": true},
            {"id": "sonnet-5.5", "name": "Sonnet 5.5", "efforts": ["low", "medium", "high"], "contextWindow": WINDOW_TOKENS, "default": false}
        ],
        "modes": ["default", "acceptEdits", "plan", "auto", "dontAsk"],
        "features": {"steer": true, "compact": true, "terminal": true, "workspace": true, "reasoning": true, "subagents": true}
    })
}

/// An API error, rendered as `{error: …}` over HTTP and as JSON-RPC `-32000`
/// (or `-32602` for `invalid_request`) on the WebSocket.
#[derive(Debug, Clone)]
pub struct ApiErr {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub retryable: bool,
    pub extra: Map<String, Value>,
}

impl ApiErr {
    pub fn new(status: u16, code: &str, message: impl Into<String>) -> Self {
        let retryable = matches!(status, 429 | 503) || code == "queue_full";
        ApiErr { status, code: code.into(), message: message.into(), retryable, extra: Map::new() }
    }
    pub fn with(mut self, k: &str, v: impl Into<Value>) -> Self {
        self.extra.insert(k.into(), v.into());
        self
    }
    pub fn field(status: u16, code: &str, field: &str, message: impl Into<String>) -> Self {
        Self::new(status, code, message).with("field", field)
    }
    pub fn bad(field: &str, message: impl Into<String>) -> Self {
        Self::field(400, "invalid_request", field, message)
    }
    pub fn body(&self, request_id: &str) -> Value {
        let mut e = Map::new();
        e.insert("code".into(), self.code.clone().into());
        e.insert("message".into(), self.message.clone().into());
        e.insert("retryable".into(), self.retryable.into());
        e.insert("requestId".into(), request_id.into());
        for (k, v) in &self.extra {
            e.insert(k.clone(), v.clone());
        }
        let err = Value::Object(e);
        validate("Error", &err);
        json!({"error": err})
    }
}

pub type ApiResult<T> = Result<T, ApiErr>;

/// What goes out to WebSocket connections.
#[derive(Debug, Clone)]
pub enum Out {
    Event(String, Arc<Value>),
    Delta(String, Arc<Value>),
}

/// Work to start once the lock is released.
#[derive(Debug, Clone)]
pub enum Job {
    Turn { sid: String, tid: String },
    Background { sid: String, said: String, ms: u64 },
    FinishInterrupt { sid: String, tid: String, actor: Value },
    Resume { sid: String },
}

pub struct Sess {
    pub id: String,
    pub title: String,
    pub archived: bool,
    pub owner: Value,
    pub origin: Value,
    pub model: Option<String>,
    pub effort: Option<String>,
    pub speed: Option<String>,
    pub mode: String,
    pub metadata: Map<String, Value>,
    pub created_at: String,
    pub last_active_at: String,
    pub turns: Vec<Value>,
    pub asks: Vec<Value>,
    pub subagents: Vec<Value>,
    pub events: Vec<Value>,
    /// The status last recorded with `session.status_changed`.
    pub status: String,
    pub suspended: bool,
    pub starting: bool,
    pub used_tokens: Option<u64>,
    pub last_ended: Option<String>,
    pub last_text: Option<String>,
    /// Top-level workspace names uploaded with `PUT /workspace/archive`: (pushedAt, pushedBy).
    pub uploads: HashMap<String, (String, Value)>,
    /// Turns that are `/compact` requests.
    pub compact_turns: HashSet<String>,
    /// tool.started data of calls still open, per turn.
    pub open_calls: HashMap<String, Vec<Value>>,
    /// Steered messages the agent has not read yet, per turn: (input, author).
    pub unread: HashMap<String, Vec<(String, Value, u64)>>,
}

pub fn st(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

impl Sess {
    pub fn last_seq(&self) -> u64 {
        self.events.len() as u64
    }
    pub fn turn(&self, tid: &str) -> Option<&Value> {
        self.turns.iter().find(|t| t["id"] == tid)
    }
    pub fn turn_mut(&mut self, tid: &str) -> Option<&mut Value> {
        self.turns.iter_mut().find(|t| t["id"] == tid)
    }
    pub fn ask(&self, aid: &str) -> Option<&Value> {
        self.asks.iter().find(|t| t["id"] == aid)
    }
    pub fn ask_mut(&mut self, aid: &str) -> Option<&mut Value> {
        self.asks.iter_mut().find(|t| t["id"] == aid)
    }
    pub fn subagent(&self, id: &str) -> Option<&Value> {
        self.subagents.iter().find(|t| t["id"] == id)
    }
    pub fn subagent_mut(&mut self, id: &str) -> Option<&mut Value> {
        self.subagents.iter_mut().find(|t| t["id"] == id)
    }
    pub fn active(&self) -> Option<&Value> {
        self.turns.iter().find(|t| matches!(t["status"].as_str(), Some("running" | "cancelling")))
    }
    pub fn active_id(&self) -> Option<String> {
        self.active().map(|t| st(t, "id"))
    }
    pub fn queued_ids(&self) -> Vec<String> {
        self.turns.iter().filter(|t| t["status"] == "queued").map(|t| st(t, "id")).collect()
    }
    pub fn open_asks(&self) -> Vec<String> {
        self.asks.iter().filter(|a| a["status"] == "open").map(|a| st(a, "id")).collect()
    }
    pub fn computed_status(&self) -> &'static str {
        if self.starting {
            "starting"
        } else if self.suspended {
            "suspended"
        } else if self.active().is_some() {
            if self.asks.iter().any(|a| a["status"] == "open") { "waiting" } else { "running" }
        } else {
            "idle"
        }
    }
    pub fn settings(&self) -> Value {
        json!({"model": self.model, "effort": self.effort, "mode": self.mode, "speed": self.speed})
    }

    pub fn to_json(&self) -> Value {
        let last_turn = self.last_ended.as_ref().and_then(|id| self.turn(id)).map(|t| {
            json!({"id": t["id"], "status": t["status"], "endedAt": t["endedAt"], "text": t["text"], "error": t["error"], "reason": t["reason"], "forced": t["forced"]})
        });
        let v = json!({
            "id": self.id,
            "title": self.title,
            "status": self.computed_status(),
            "archived": self.archived,
            "owner": self.owner,
            "origin": self.origin,
            "settings": self.settings(),
            "metadata": self.metadata,
            "activeTurnId": self.active_id(),
            "queued": self.turns.iter().filter(|t| t["status"] == "queued").cloned().collect::<Vec<_>>(),
            "asks": self.asks.iter().filter(|a| a["status"] == "open").cloned().collect::<Vec<_>>(),
            "subagents": self.subagents.iter().filter(|s| s["status"] == "running").cloned().collect::<Vec<_>>(),
            "lastTurn": last_turn,
            "lastText": self.last_text,
            "context": {"usedTokens": self.used_tokens, "windowTokens": WINDOW_TOKENS},
            "lastSeq": self.last_seq(),
            "logEpoch": 1,
            "epochStartSeq": 1,
            "createdAt": self.created_at,
            "lastActiveAt": self.last_active_at,
            "syncedAt": null,
            "urls": {"dashboard": format!("https://app.opencomputer.dev/computer/sessions/{}", self.id)},
        });
        validate("Session", &v);
        v
    }
}

/// How a turn ends.
pub enum End {
    Completed { text: Option<String>, silent: bool },
    Failed { code: String, message: String },
    Cancelled { reason: String, forced: bool },
}

pub struct World {
    pub sessions: Vec<Sess>,
    /// Idempotency-Key → (fingerprint, status, response, kind).
    pub idem: HashMap<String, Idem>,
    pub jobs: Vec<Job>,
    pub bus: broadcast::Sender<Out>,
    pub interrupt_spares_background: bool,
}

pub struct Idem {
    pub fingerprint: String,
    pub status: u16,
    pub response: Value,
}

impl World {
    pub fn sess(&self, sid: &str) -> ApiResult<&Sess> {
        self.sessions.iter().find(|s| s.id == sid).ok_or_else(|| ApiErr::new(404, "session_not_found", format!("no session {sid}")))
    }
    pub fn sess_mut(&mut self, sid: &str) -> ApiResult<&mut Sess> {
        self.sessions.iter_mut().find(|s| s.id == sid).ok_or_else(|| ApiErr::new(404, "session_not_found", format!("no session {sid}")))
    }
    pub fn s(&mut self, sid: &str) -> &mut Sess {
        self.sess_mut(sid).expect("session exists")
    }

    /// Appends an event to the session's log. Returns its seq.
    pub fn emit(&mut self, sid: &str, turn_id: Option<&str>, ty: &str, actor: Option<&Value>, data: Value) -> u64 {
        let s = self.s(sid);
        let seq = s.last_seq() + 1;
        let ev = json!({
            "id": new_id("ev_"),
            "seq": seq,
            "createdAt": now(),
            "sessionId": sid,
            "turnId": turn_id,
            "type": ty,
            "actor": actor,
            "data": data,
        });
        validate("Event", &ev);
        s.last_active_at = now();
        s.events.push(ev.clone());
        let _ = self.bus.send(Out::Event(sid.to_string(), Arc::new(ev)));
        seq
    }

    /// Sends a delta (never recorded) to attaches that asked for deltas.
    pub fn delta(&mut self, sid: &str, turn_id: Option<&str>, ty: &str, data: Value) {
        let d = json!({"type": ty, "sessionId": sid, "turnId": turn_id, "data": data});
        validate("Delta", &d);
        let _ = self.bus.send(Out::Delta(sid.to_string(), Arc::new(d)));
    }

    /// Records `session.status_changed` for every session whose status moved.
    pub fn settle(&mut self) {
        let changed: Vec<(String, String, &'static str, Option<String>)> = self
            .sessions
            .iter()
            .filter(|s| s.status != s.computed_status())
            .map(|s| (s.id.clone(), s.status.clone(), s.computed_status(), s.active_id()))
            .collect();
        for (sid, from, to, tid) in changed {
            self.emit(&sid, tid.as_deref(), "session.status_changed", None, json!({"from": from, "to": to}));
            self.s(&sid).status = to.to_string();
        }
    }

    #[allow(clippy::too_many_arguments)]
    pub fn create_session(&mut self, id: String, title: String, owner: Value, origin: Value, settings: (Option<String>, Option<String>, String), metadata: Map<String, Value>, actor: Option<&Value>) {
        let t = now();
        let sess = Sess {
            id: id.clone(),
            title: title.clone(),
            archived: false,
            owner,
            origin: origin.clone(),
            model: settings.0,
            effort: settings.1,
            speed: None,
            mode: settings.2,
            metadata,
            created_at: t.clone(),
            last_active_at: t,
            turns: vec![],
            asks: vec![],
            subagents: vec![],
            events: vec![],
            status: "idle".into(),
            suspended: false,
            starting: false,
            used_tokens: None,
            last_ended: None,
            last_text: None,
            uploads: HashMap::new(),
            compact_turns: HashSet::new(),
            open_calls: HashMap::new(),
            unread: HashMap::new(),
        };
        let settings = sess.settings();
        self.sessions.push(sess);
        self.emit(&id, None, "session.created", actor, json!({"title": title, "origin": origin, "settings": settings}));
    }

    pub fn new_turn(&mut self, sid: &str, trigger: &str, input: Option<String>, if_busy: &str, author: &Value, subagent_id: Option<String>) -> String {
        let tid = new_id("tn_");
        let t = json!({
            "id": tid, "sessionId": sid, "status": "queued", "trigger": trigger, "subagentId": subagent_id,
            "ifBusy": if_busy, "input": input, "author": author, "steering": [], "createdAt": now(),
            "startedAt": null, "endedAt": null, "text": null, "error": null, "reason": null, "forced": null, "usage": null,
        });
        validate("Turn", &t);
        self.s(sid).turns.push(t);
        tid
    }

    pub fn start_turn(&mut self, sid: &str, tid: &str) {
        let s = self.s(sid);
        let settings = s.settings();
        let t = s.turn_mut(tid).expect("turn");
        t["status"] = "running".into();
        t["startedAt"] = now().into();
        let data = json!({"model": settings["model"], "effort": settings["effort"], "mode": settings["mode"], "trigger": t["trigger"], "subagentId": t["subagentId"]});
        self.emit(sid, Some(tid), "turn.started", None, data);
        self.jobs.push(Job::Turn { sid: sid.into(), tid: tid.into() });
    }

    /// Starts the next queued turn when nothing runs.
    pub fn advance(&mut self, sid: &str) {
        let s = self.s(sid);
        if s.active().is_some() || s.suspended || s.starting {
            return;
        }
        if let Some(next) = s.queued_ids().first().cloned() {
            self.start_turn(sid, &next);
        }
    }

    /// The agent takes in steered messages: `turn.steered` for each.
    pub fn read_steering(&mut self, sid: &str, tid: &str) {
        let Some(msgs) = self.s(sid).unread.remove(tid) else { return };
        for (_, author, seq) in msgs {
            self.emit(sid, Some(tid), "turn.steered", Some(&author), json!({"messageSeq": seq}));
        }
    }

    pub fn end_turn(&mut self, sid: &str, tid: &str, end: End, actor: Option<&Value>) {
        let model = self.s(sid).model.clone();
        let started = self.s(sid).turn(tid).map(|t| st(t, "startedAt")).unwrap_or_default();
        let was_running = self.s(sid).turn(tid).is_some_and(|t| !t["startedAt"].is_null());
        let duration_ms = if was_running { duration_since(&started) } else { 0 };
        let event_type = match &end {
            End::Completed { .. } => "turn.completed",
            End::Failed { .. } => "turn.failed",
            End::Cancelled { .. } => "turn.cancelled",
        };
        // Settle calls still open.
        if let Some(calls) = self.s(sid).open_calls.remove(tid) {
            for c in calls {
                let data = json!({
                    "subagentId": c["subagentId"], "toolName": c["toolName"], "callId": c["callId"], "parentCallId": c["parentCallId"],
                    "title": c["title"], "message": "the turn ended before the call", "settledBy": event_type,
                });
                self.emit(sid, Some(tid), "tool.failed", None, data);
            }
        }
        let usage = if was_running {
            let u = json!({"inputTokens": 1200, "outputTokens": 80, "reasoningTokens": 0, "cachedTokens": 1000, "cacheWriteTokens": 0, "costUsd": "0.01"});
            let used = self.s(sid).used_tokens.unwrap_or(0) + 1280;
            self.s(sid).used_tokens = Some(used);
            let mut data = u.clone();
            data["model"] = model.clone().into();
            data["firstTokenMs"] = 5.into();
            data["durationMs"] = duration_ms.into();
            data["usedTokens"] = used.into();
            data["windowTokens"] = WINDOW_TOKENS.into();
            self.emit(sid, Some(tid), "usage.recorded", None, data);
            Some(u)
        } else {
            None
        };
        let s = self.s(sid);
        let t = s.turn_mut(tid).expect("turn");
        t["endedAt"] = now().into();
        t["usage"] = usage.into();
        let input = t["input"].clone();
        let (data, text) = match end {
            End::Completed { text, silent } => {
                t["status"] = "completed".into();
                t["text"] = text.clone().into();
                let d = json!({"text": text, "durationMs": duration_ms, "silent": silent});
                (d, Some(text))
            }
            End::Failed { code, message } => {
                t["status"] = "failed".into();
                let e = json!({"code": code, "message": message});
                t["error"] = e.clone();
                (json!({"error": e}), None)
            }
            End::Cancelled { reason, forced } => {
                t["status"] = "cancelled".into();
                t["reason"] = reason.clone().into();
                t["forced"] = forced.into();
                (json!({"reason": reason, "forced": forced, "input": input}), None)
            }
        };
        validate("Turn", t);
        if was_running || event_type != "turn.cancelled" {
            s.last_ended = Some(tid.to_string());
        }
        if let Some(Some(text)) = text {
            s.last_text = Some(text);
        }
        self.emit(sid, Some(tid), event_type, actor, data);
        // A steered message the agent never read starts a new turn at once, ahead of the queue.
        if let Some(msgs) = self.s(sid).unread.remove(tid) {
            for (input, author, _) in msgs {
                let t = self.s(sid).turn_mut(tid).expect("turn");
                if let Some(a) = t["steering"].as_array_mut()
                    && let Some(i) = a.iter().rposition(|m| m["input"] == input.as_str())
                {
                    a.remove(i);
                }
                let new = self.new_turn(sid, "message", Some(input), "steer", &author, None);
                let s = self.s(sid);
                let t = s.turns.pop().unwrap();
                let at = s.turns.iter().position(|x| x["status"] == "queued").unwrap_or(s.turns.len());
                s.turns.insert(at, t);
                let position = s.turns.iter().filter(|x| x["status"] == "queued").position(|x| x["id"] == new.as_str()).unwrap() + 1;
                let starts_now = position == 1 && s.active().is_none() && !s.suspended && !s.starting;
                if !starts_now {
                    self.emit(sid, Some(&new), "turn.queued", None, json!({"position": position, "trigger": "message", "subagentId": null}));
                }
            }
        }
        self.advance(sid);
    }

    pub fn close_ask(&mut self, sid: &str, aid: &str, status: &str, by: Option<&Value>, answer: Value) {
        let s = self.s(sid);
        let a = s.ask_mut(aid).expect("ask");
        a["status"] = status.into();
        a["closedAt"] = now().into();
        a["closedBy"] = by.cloned().unwrap_or(Value::Null);
        a["answer"] = answer;
        let a = a.clone();
        validate("Ask", &a);
        let tid = st(&a, "turnId");
        self.emit(sid, Some(&tid), "ask.closed", by, json!({"ask": a}));
    }

    pub fn end_subagent(&mut self, sid: &str, said: &str, status: &str, result: Option<String>, stopped_by: Option<&Value>) {
        let s = self.s(sid);
        let sa = s.subagent_mut(said).expect("subagent");
        sa["status"] = status.into();
        sa["endedAt"] = now().into();
        sa["durationMs"] = duration_since(&st(sa, "createdAt")).into();
        sa["result"] = result.into();
        sa["activity"] = Value::Null;
        sa["stoppedBy"] = stopped_by.cloned().unwrap_or(Value::Null);
        let sa = sa.clone();
        validate("Subagent", &sa);
        let tid = st(&sa, "turnId");
        self.emit(sid, Some(&tid), "subagent.ended", stopped_by, json!({"subagent": sa}));
    }

    /// The end of an interrupt: asks close `interrupted`, subagents stop, the turn is cancelled.
    pub fn finish_interrupt(&mut self, sid: &str, tid: &str, actor: &Value) {
        let Ok(s) = self.sess(sid) else { return };
        if !s.turn(tid).is_some_and(|t| matches!(t["status"].as_str(), Some("running" | "cancelling"))) {
            return;
        }
        let asks: Vec<String> = s.asks.iter().filter(|a| a["status"] == "open" && a["turnId"] == tid).map(|a| st(a, "id")).collect();
        let spare_bg = self.interrupt_spares_background;
        let subs: Vec<String> = s
            .subagents
            .iter()
            .filter(|x| x["status"] == "running" && ((x["turnId"] == tid && x["background"] == false) || (x["background"] == true && !spare_bg)))
            .map(|x| st(x, "id"))
            .collect();
        for a in asks {
            self.close_ask(sid, &a, "interrupted", Some(actor), Value::Null);
        }
        for x in subs {
            self.end_subagent(sid, &x, "stopped", None, Some(actor));
        }
        self.end_turn(sid, tid, End::Cancelled { reason: "interrupted".into(), forced: false }, Some(actor));
    }

    pub fn cancel_queued(&mut self, sid: &str, reason: &str, actor: &Value) -> Vec<String> {
        let q = self.s(sid).queued_ids();
        for t in &q {
            self.end_turn(sid, t, End::Cancelled { reason: reason.into(), forced: false }, Some(actor));
        }
        q
    }

    /// Delivers a message. Returns (turn id, delivery).
    pub fn send(&mut self, sid: &str, input: String, if_busy: &str, author: &Value) -> ApiResult<(String, &'static str)> {
        let s = self.s(sid);
        let active = s.active().cloned();
        let Some(active) = active else {
            let tid = self.new_turn(sid, "message", Some(input.clone()), if_busy, author, None);
            self.emit(sid, Some(&tid), "message.received", Some(author), json!({"input": input, "ifBusy": if_busy, "delivery": "started", "interruptedTurnIds": [], "declinedAskIds": []}));
            let s = self.s(sid);
            if s.suspended && !s.starting {
                self.begin_resume(sid);
            } else {
                self.advance(sid);
            }
            return Ok((tid, "started"));
        };
        let atid = st(&active, "id");
        let cancelling = active["status"] == "cancelling";
        match if_busy {
            "interrupt" => {
                let mut stopped = vec![atid.clone()];
                stopped.extend(self.s(sid).queued_ids());
                let tid = self.new_turn(sid, "message", Some(input.clone()), if_busy, author, None);
                self.emit(sid, Some(&tid), "message.received", Some(author), json!({"input": input, "ifBusy": if_busy, "delivery": "started", "interruptedTurnIds": stopped, "declinedAskIds": []}));
                for q in self.s(sid).queued_ids().into_iter().filter(|q| *q != tid) {
                    self.end_turn(sid, &q, End::Cancelled { reason: "interrupted".into(), forced: false }, Some(author));
                }
                self.finish_interrupt(sid, &atid, author);
                self.advance(sid);
                Ok((tid, "started"))
            }
            "steer" if !cancelling => {
                let open: Vec<String> = self.s(sid).open_asks();
                // A message sent while an ask is open declines it and is delivered as steering.
                let mseq = self.emit(sid, Some(&atid), "message.received", Some(author), json!({"input": input, "ifBusy": if_busy, "delivery": "steered", "interruptedTurnIds": [], "declinedAskIds": open}));
                for a in open {
                    self.close_ask(sid, &a, "declined", Some(author), json!({"message": input, "messageSeq": mseq}));
                }
                let t = self.s(sid).turn_mut(&atid).expect("turn");
                t["steering"].as_array_mut().unwrap().push(json!({"input": input, "author": author, "createdAt": now()}));
                // turn.steered is recorded when the agent reads it, at its next step.
                self.s(sid).unread.entry(atid.clone()).or_default().push((input, author.clone(), mseq));
                Ok((atid, "steered"))
            }
            _ => {
                let queued = self.s(sid).queued_ids().len();
                if queued >= MAX_QUEUE {
                    return Err(ApiErr::new(409, "queue_full", "20 turns are already queued").with("retryAfterMs", 1000));
                }
                let tid = self.new_turn(sid, "message", Some(input.clone()), if_busy, author, None);
                self.emit(sid, Some(&tid), "message.received", Some(author), json!({"input": input, "ifBusy": if_busy, "delivery": "queued", "interruptedTurnIds": [], "declinedAskIds": []}));
                self.emit(sid, Some(&tid), "turn.queued", Some(author), json!({"position": queued + 1, "trigger": "message", "subagentId": null}));
                Ok((tid, "queued"))
            }
        }
    }

    pub fn begin_resume(&mut self, sid: &str) {
        let s = self.s(sid);
        s.starting = true;
        self.jobs.push(Job::Resume { sid: sid.into() });
    }

    pub fn finish_resume(&mut self, sid: &str) {
        let Ok(s) = self.sess_mut(sid) else { return };
        if !s.starting {
            return;
        }
        s.starting = false;
        s.suspended = false;
        self.emit(sid, None, "runtime.connected", None, json!({"warm": true, "resumed": true, "durationMs": 40}));
        self.advance(sid);
    }

    /// A background subagent finished: the agent takes a turn of its own.
    pub fn subagent_turn(&mut self, sid: &str, said: &str) {
        let s = self.s(sid);
        let author = Value::Null;
        let busy = s.active().is_some() || s.suspended || s.starting;
        let position = s.queued_ids().len() + 1;
        let tid = self.new_turn(sid, "subagent", None, "queue", &author, Some(said.to_string()));
        if busy {
            self.emit(sid, Some(&tid), "turn.queued", None, json!({"position": position, "trigger": "subagent", "subagentId": said}));
        } else {
            self.advance(sid);
        }
    }
}

pub fn duration_since(iso: &str) -> u64 {
    let Ok(t) = time::OffsetDateTime::parse(iso, &time::format_description::well_known::Rfc3339) else { return 0 };
    let d = time::OffsetDateTime::now_utc() - t;
    d.whole_milliseconds().max(0) as u64
}

/// Everything shared by the server tasks and the harness.
pub struct Shared {
    pub world: Mutex<World>,
    pub version: watch::Sender<u64>,
    pub bus: broadcast::Sender<Out>,
    pub ctl: broadcast::Sender<(u16, String)>,
    pub knobs: Mutex<Knobs>,
    pub requests: Mutex<Vec<LoggedRequest>>,
    pub frames: Mutex<Vec<WsFrame>>,
    pub handle: tokio::runtime::Handle,
    pub workspace_root: PathBuf,
    pub api_url: String,
    pub wire_url: String,
    pub ws_connections: Mutex<u64>,
}

impl Shared {
    /// Runs a change under the lock, records status changes, then starts jobs and wakes waiters.
    pub fn with<R>(self: &Arc<Self>, f: impl FnOnce(&mut World) -> R) -> R {
        let (r, jobs) = {
            let mut w = self.world.lock().unwrap();
            w.interrupt_spares_background = self.knobs.lock().unwrap().interrupt_spares_background;
            let r = f(&mut w);
            w.settle();
            (r, std::mem::take(&mut w.jobs))
        };
        self.version.send_modify(|v| *v += 1);
        for j in jobs {
            self.spawn_job(j);
        }
        r
    }

    /// Reads under the lock without changing anything.
    pub fn read<R>(&self, f: impl FnOnce(&World) -> R) -> R {
        f(&self.world.lock().unwrap())
    }

    fn spawn_job(self: &Arc<Self>, j: Job) {
        let sh = self.clone();
        match j {
            Job::Turn { sid, tid } => {
                self.handle.spawn(super::agent::run_turn(sh, sid, tid));
            }
            Job::Background { sid, said, ms } => {
                self.handle.spawn(super::agent::run_background(sh, sid, said, ms));
            }
            Job::FinishInterrupt { sid, tid, actor } => {
                self.handle.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(30)).await;
                    sh.with(|w| w.finish_interrupt(&sid, &tid, &actor));
                });
            }
            Job::Resume { sid } => {
                self.handle.spawn(async move {
                    tokio::time::sleep(Duration::from_millis(40)).await;
                    sh.with(|w| w.finish_resume(&sid));
                });
            }
        }
    }

    /// Waits until `cond` holds or `timeout` passes (None: forever). Returns whether it holds.
    pub async fn wait_until(&self, timeout: Option<Duration>, mut cond: impl FnMut(&World) -> bool) -> bool {
        let mut rx = self.version.subscribe();
        let deadline = timeout.map(|t| tokio::time::Instant::now() + t);
        loop {
            rx.borrow_and_update();
            if self.read(&mut cond) {
                return true;
            }
            let changed = rx.changed();
            match deadline {
                Some(d) => {
                    if tokio::time::timeout_at(d, changed).await.is_err() {
                        return self.read(&mut cond);
                    }
                }
                None => {
                    if changed.await.is_err() {
                        return false;
                    }
                }
            }
        }
    }
}
