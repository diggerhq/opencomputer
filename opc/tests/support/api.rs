//! Operations shared by HTTP routes and WebSocket methods. An operation takes
//! a [`Call`] (path ids, query, body, idempotency key, actor) and returns a
//! status and a JSON result, validated against the schema before it leaves.

use super::model::*;
use super::schema::validate;
use serde_json::{Map, Value, json};
use std::sync::Arc;
use std::time::Duration;

#[derive(Debug, Clone, Default)]
pub struct Call {
    pub op: String,
    pub sid: Option<String>,
    /// The second id in the path: turn, ask, subagent, or secret name.
    pub sub: Option<String>,
    pub query: Map<String, Value>,
    pub body: Value,
    pub idem: Option<String>,
    pub actor: Value,
    /// Body fields an operation accepts; anything else is `400 invalid_request` with `field`.
    pub strict_body: bool,
}

const WRITES: &[&str] = &[
    "sessions.create",
    "sessions.update",
    "sessions.interrupt",
    "sessions.compact",
    "sessions.suspend",
    "sessions.resume",
    "turns.send",
    "turns.cancel",
    "asks.answer",
    "asks.dismiss",
    "subagents.stop",
];

pub fn canonical(v: &Value) -> String {
    fn walk(v: &Value) -> Value {
        match v {
            Value::Object(m) => {
                let mut keys: Vec<_> = m.keys().collect();
                keys.sort();
                let mut out = Map::new();
                for k in keys {
                    out.insert(k.clone(), walk(&m[k]));
                }
                Value::Object(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(walk).collect()),
            _ => v.clone(),
        }
    }
    walk(v).to_string()
}

impl Call {
    fn sid(&self) -> &str {
        self.sid.as_deref().unwrap_or("")
    }
    fn sub(&self) -> &str {
        self.sub.as_deref().unwrap_or("")
    }
    pub fn q(&self, k: &str) -> Option<String> {
        match self.query.get(k)? {
            Value::String(s) => Some(s.clone()),
            Value::Null => None,
            v => Some(v.to_string()),
        }
    }
    pub fn qn(&self, k: &str, min: u64, max: u64) -> ApiResult<Option<u64>> {
        match self.q(k) {
            None => Ok(None),
            Some(s) => match s.parse::<u64>() {
                Ok(n) if n >= min && n <= max => Ok(Some(n)),
                _ => Err(ApiErr::bad(k, format!("{k} must be an integer from {min} to {max}"))),
            },
        }
    }
    fn b(&self, k: &str) -> Option<&Value> {
        self.body.get(k).filter(|v| !v.is_null())
    }
    fn bs(&self, k: &str) -> ApiResult<Option<String>> {
        match self.b(k) {
            None => Ok(None),
            Some(Value::String(s)) => Ok(Some(s.clone())),
            Some(_) => Err(ApiErr::bad(k, format!("{k} must be a string"))),
        }
    }
    fn allow(&self, fields: &[&str]) -> ApiResult<()> {
        if !self.strict_body {
            return Ok(());
        }
        match &self.body {
            Value::Null => Ok(()),
            Value::Object(m) => match m.keys().find(|k| !fields.contains(&k.as_str())) {
                Some(k) => Err(ApiErr::bad(k, format!("unknown field {k}"))),
                None => Ok(()),
            },
            _ => Err(ApiErr::bad("body", "the body must be a JSON object")),
        }
    }
}

fn seq(w: &World, sid: &str) -> u64 {
    w.sess(sid).map(|s| s.last_seq()).unwrap_or(0)
}

fn page(items: Vec<Value>, limit: usize, cursor: Option<String>) -> ApiResult<(Vec<Value>, Value)> {
    let start = match cursor {
        None => 0,
        Some(c) => c.strip_prefix("c").and_then(|n| n.parse::<usize>().ok()).ok_or_else(|| ApiErr::new(400, "invalid_cursor", "unknown cursor"))?,
    };
    let end = (start + limit).min(items.len());
    let next = if end < items.len() { json!(format!("c{end}")) } else { Value::Null };
    Ok((items.get(start..end).map(<[Value]>::to_vec).unwrap_or_default(), next))
}

fn check_speed(speed: Option<String>) -> ApiResult<Option<String>> {
    match speed.as_deref() {
        None | Some("fast" | "standard") => Ok(speed),
        Some(s) => Err(ApiErr::bad("speed", format!("speed must be fast or standard, not {s}"))),
    }
}

fn check_settings(model: &Option<String>, effort: &Option<String>, mode: &Option<String>) -> ApiResult<()> {
    let caps = capabilities();
    if let Some(m) = model {
        let Some(found) = caps["models"].as_array().unwrap().iter().find(|x| x["id"] == m.as_str()) else {
            return Err(ApiErr::field(400, "unsupported_model", "model", format!("unknown model {m}")));
        };
        if let Some(e) = effort
            && !found["efforts"].as_array().unwrap().iter().any(|x| x == e.as_str())
        {
            return Err(ApiErr::field(400, "unsupported_effort", "effort", format!("{m} does not support effort {e}")));
        }
    }
    if let Some(e) = effort
        && !["low", "medium", "high", "xhigh", "max"].contains(&e.as_str())
    {
        return Err(ApiErr::field(400, "unsupported_effort", "effort", format!("unknown effort {e}")));
    }
    if let Some(m) = mode
        && !caps["modes"].as_array().unwrap().iter().any(|x| x == m.as_str())
    {
        return Err(ApiErr::field(400, "unsupported_mode", "mode", format!("unknown mode {m}")));
    }
    Ok(())
}

fn string_map(v: Option<&Value>, field: &str) -> ApiResult<Map<String, Value>> {
    match v {
        None => Ok(Map::new()),
        Some(Value::Object(m)) => {
            for (k, v) in m {
                if !v.is_string() && !v.is_null() {
                    return Err(ApiErr::bad(&format!("{field}.{k}"), "metadata values are strings"));
                }
            }
            Ok(m.clone())
        }
        Some(_) => Err(ApiErr::bad(field, "metadata must be an object")),
    }
}

fn valid_session_id(id: &str) -> bool {
    id.len() == 19 && id.starts_with("cs_") && id[3..].bytes().all(|b| ALPHABET.contains(&b))
}

/// Runs an operation, with idempotency for writes.
pub async fn dispatch(sh: &Arc<Shared>, call: Call) -> ApiResult<(u16, Value)> {
    let is_write = WRITES.contains(&call.op.as_str());
    let fingerprint = format!("{} {} {} {}", call.op, call.sid(), call.sub(), canonical(&call.body));
    if is_write && let Some(key) = &call.idem {
        let replay = sh.read(|w| w.idem.get(key).map(|i| (i.fingerprint.clone(), i.status, i.response.clone())));
        if let Some((fp, status, resp)) = replay {
            if fp != fingerprint {
                return Err(ApiErr::field(409, "idempotency_conflict", "Idempotency-Key", "this Idempotency-Key was used with a different request"));
            }
            return Ok(sh.read(|w| replay_current(w, &call, status, resp)));
        }
    }
    let (status, body) = run(sh, &call).await?;
    if is_write && let Some(key) = &call.idem {
        sh.with(|w| w.idem.insert(key.clone(), Idem { fingerprint, status, response: body.clone() }));
    }
    Ok((status, body))
}

/// A repeated create or send returns the current state with `duplicate: true`.
fn replay_current(w: &World, call: &Call, status: u16, mut resp: Value) -> (u16, Value) {
    match call.op.as_str() {
        "sessions.create" | "turns.send" | "sessions.compact" => {
            let sid = if call.op == "sessions.create" { st(&resp["session"], "id") } else { call.sid().to_string() };
            if let Ok(s) = w.sess(&sid) {
                if call.op == "sessions.create" {
                    resp["session"] = s.to_json();
                }
                if let Some(t) = resp["turn"].as_str().map(str::to_string).or_else(|| resp["turn"]["id"].as_str().map(str::to_string))
                    && let Some(t) = s.turn(&t)
                {
                    resp["turn"] = t.clone();
                }
            }
            resp["duplicate"] = true.into();
            (200, resp)
        }
        _ => (status, resp),
    }
}

async fn run(sh: &Arc<Shared>, c: &Call) -> ApiResult<(u16, Value)> {
    let actor = &c.actor;
    match c.op.as_str() {
        "me" => {
            let k = sh.knobs.lock().unwrap();
            let v = json!({
                "person": me(),
                "organization": {"id": "org_acme0000001", "name": "acme"},
                "credential": {"id": "key_8q2x7c1v9b4m", "name": "test-machine", "kind": "login",
                    "scopes": ["sessions:read", "sessions:write", "asks:answer", "secrets:write", "terminals"], "expiresAt": null, "createdAt": "2026-10-25T18:02:11.000Z"},
                "computer": {"status": k.computer_status, "region": "fra", "wireUrl": if k.ws_enabled { json!(sh.wire_url) } else { Value::Null }},
                "defaults": {"model": "opus-5.5", "effort": "high", "mode": "default"},
                "capabilities": capabilities(),
            });
            validate("Person", &v["person"]);
            validate("Capabilities", &v["capabilities"]);
            Ok((200, v))
        }
        "tickets.create" => {
            let token = rand_str(32);
            Ok((200, json!({"ticket": {"token": token, "url": format!("{}?ticket={token}", sh.wire_url), "expiresAt": now(), "expiresInMs": 600000}})))
        }
        "sessions.create" => create(sh, c).await,
        "sessions.list" => list_sessions(sh, c),
        "sessions.get" => {
            wait_min_seq(sh, c).await?;
            let v = sh.read(|w| w.sess(c.sid()).map(|s| json!({"session": s.to_json()})))?;
            validate("method:sessions.get", &v);
            Ok((200, v))
        }
        "sessions.capabilities" => {
            sh.read(|w| w.sess(c.sid()).map(|_| ()))?;
            Ok((200, json!({"capabilities": capabilities()})))
        }
        "sessions.update" => update(sh, c),
        "sessions.interrupt" => {
            c.allow(&["turnId"])?;
            let turn_id = c.bs("turnId")?;
            let r = sh.with(|w| -> ApiResult<(u16, Value)> {
                let s = w.sess(c.sid())?;
                let active = s.active_id();
                let applies = match (&active, &turn_id) {
                    (None, _) => false,
                    (Some(a), Some(t)) => a == t && s.turn(a).is_some_and(|x| x["status"] == "running"),
                    (Some(a), None) => s.turn(a).is_some_and(|x| x["status"] == "running"),
                };
                if !applies {
                    let s = w.sess(c.sid())?;
                    return Ok((200, json!({"session": s.to_json(), "seq": s.last_seq()})));
                }
                let a = active.unwrap();
                w.cancel_queued(c.sid(), "interrupted", actor);
                let t = w.s(c.sid()).turn_mut(&a).unwrap();
                t["status"] = "cancelling".into();
                w.emit(c.sid(), Some(&a), "turn.status_changed", Some(actor), json!({"from": "running", "to": "cancelling"}));
                w.jobs.push(Job::FinishInterrupt { sid: c.sid().into(), tid: a, actor: actor.clone() });
                let s = w.sess(c.sid())?;
                Ok((202, json!({"session": s.to_json(), "seq": s.last_seq()})))
            })?;
            validate("method:sessions.interrupt", &r.1);
            Ok(r)
        }
        "sessions.compact" => {
            c.allow(&["instructions"])?;
            let instr = c.bs("instructions")?;
            let input = match instr {
                Some(i) if !i.is_empty() => format!("/compact {i}"),
                _ => "/compact".into(),
            };
            let v = sh.with(|w| -> ApiResult<Value> {
                w.sess(c.sid())?;
                let (tid, delivery) = w.send(c.sid(), input, "queue", actor)?;
                w.s(c.sid()).compact_turns.insert(tid.clone());
                let s = w.sess(c.sid())?;
                Ok(json!({"turn": s.turn(&tid).unwrap(), "delivery": delivery, "duplicate": false, "seq": s.last_seq()}))
            })?;
            validate("method:sessions.compact", &v);
            Ok((202, v))
        }
        "sessions.suspend" => {
            c.allow(&["ifIdle"])?;
            let r = sh.with(|w| -> ApiResult<(u16, Value)> {
                let s = w.sess(c.sid())?;
                if s.suspended && !s.starting {
                    return Ok((200, json!({"session": s.to_json(), "seq": s.last_seq()})));
                }
                let active = s.active_id();
                if active.is_some() && s.open_asks().is_empty() {
                    return Err(ApiErr::new(409, "session_busy", "a turn is running"));
                }
                let asks = s.open_asks();
                let subs: Vec<String> = s.subagents.iter().filter(|x| x["status"] == "running").map(|x| st(x, "id")).collect();
                for a in asks {
                    w.close_ask(c.sid(), &a, "interrupted", Some(actor), Value::Null);
                }
                for x in subs {
                    w.end_subagent(c.sid(), &x, "stopped", None, Some(actor));
                }
                if let Some(t) = active {
                    w.s(c.sid()).suspended = true; // keeps advance() from starting the queue
                    w.end_turn(c.sid(), &t, End::Cancelled { reason: "interrupted".into(), forced: false }, Some(actor));
                }
                w.s(c.sid()).suspended = true;
                w.emit(c.sid(), None, "runtime.suspended", Some(actor), json!({"reason": "requested"}));
                let s = w.sess(c.sid())?;
                Ok((202, json!({"session": s.to_json(), "seq": s.last_seq()})))
            })?;
            validate("method:sessions.suspend", &r.1);
            Ok(r)
        }
        "sessions.resume" => {
            let r = sh.with(|w| -> ApiResult<(u16, Value)> {
                let s = w.sess(c.sid())?;
                if !s.suspended || s.starting {
                    return Ok((200, json!({"session": s.to_json(), "seq": s.last_seq()})));
                }
                w.begin_resume(c.sid());
                w.settle();
                let s = w.sess(c.sid())?;
                Ok((202, json!({"session": s.to_json(), "seq": s.last_seq()})))
            })?;
            validate("method:sessions.resume", &r.1);
            Ok(r)
        }
        "turns.send" => {
            c.allow(&["input", "ifBusy"])?;
            let input = c.bs("input")?.filter(|s| !s.is_empty()).ok_or_else(|| ApiErr::bad("input", "input is required"))?;
            if input.len() > 100_000 {
                return Err(ApiErr::bad("input", "input is longer than 100000 characters"));
            }
            let if_busy = c.bs("ifBusy")?.unwrap_or_else(|| "queue".into());
            if !["queue", "steer", "interrupt"].contains(&if_busy.as_str()) {
                return Err(ApiErr::bad("ifBusy", "ifBusy is queue, steer or interrupt"));
            }
            let v = sh.with(|w| -> ApiResult<Value> {
                w.sess(c.sid())?;
                let (tid, delivery) = w.send(c.sid(), input, &if_busy, actor)?;
                let s = w.sess(c.sid())?;
                Ok(json!({"turn": s.turn(&tid).unwrap(), "delivery": delivery, "duplicate": false, "seq": s.last_seq()}))
            })?;
            validate("method:turns.send", &v);
            Ok((202, v))
        }
        "turns.list" => {
            wait_min_seq(sh, c).await?;
            let limit = c.qn("limit", 1, 100)?.unwrap_or(20) as usize;
            let statuses: Option<Vec<String>> = c.q("status").map(|s| s.split(',').map(str::to_string).collect());
            let items = sh.read(|w| -> ApiResult<Vec<Value>> {
                let s = w.sess(c.sid())?;
                Ok(s.turns.iter().rev().filter(|t| statuses.as_ref().is_none_or(|l| l.contains(&st(t, "status")))).cloned().collect())
            })?;
            let (turns, next) = page(items, limit, c.q("cursor"))?;
            for t in &turns {
                validate("Turn", t);
            }
            Ok((200, json!({"turns": turns, "nextCursor": next})))
        }
        "turns.get" => {
            wait_min_seq(sh, c).await?;
            let wait = c.qn("waitMs", 0, 60000)?.unwrap_or(0);
            let status = c.q("status");
            sh.read(|w| w.sess(c.sid())?.turn(c.sub()).map(|_| ()).ok_or_else(|| ApiErr::new(404, "turn_not_found", "no such turn")))?;
            if wait > 0 {
                let (sid, tid) = (c.sid().to_string(), c.sub().to_string());
                sh.wait_until(Some(Duration::from_millis(wait)), move |w| {
                    let s = w.sess(&sid).ok().and_then(|s| s.turn(&tid).map(|t| st(t, "status"))).unwrap_or_default();
                    match &status {
                        Some(x) => s != *x,
                        None => matches!(s.as_str(), "completed" | "failed" | "cancelled"),
                    }
                })
                .await;
            }
            let v = sh.read(|w| -> ApiResult<Value> { Ok(json!({"turn": w.sess(c.sid())?.turn(c.sub()).cloned().unwrap()})) })?;
            validate("method:turns.get", &v);
            Ok((200, v))
        }
        "turns.cancel" => {
            let v = sh.with(|w| -> ApiResult<Value> {
                let s = w.sess(c.sid())?;
                let t = s.turn(c.sub()).cloned().ok_or_else(|| ApiErr::new(404, "turn_not_found", "no such turn"))?;
                if t["status"] != "queued" {
                    return Err(ApiErr::new(409, "turn_not_cancellable", format!("the turn is {}", st(&t, "status"))).with("turn", t));
                }
                w.end_turn(c.sid(), c.sub(), End::Cancelled { reason: "withdrawn".into(), forced: false }, Some(actor));
                let s = w.sess(c.sid())?;
                Ok(json!({"turn": s.turn(c.sub()).unwrap(), "seq": s.last_seq()}))
            })?;
            validate("method:turns.cancel", &v);
            Ok((200, v))
        }
        "events.list" => events_list(sh, c).await,
        "asks.list" => {
            let status = c.q("status").unwrap_or_else(|| "open".into());
            let limit = c.qn("limit", 1, 100)?.unwrap_or(20) as usize;
            let items = sh.read(|w| -> ApiResult<Vec<Value>> {
                Ok(w.sess(c.sid())?.asks.iter().filter(|a| status == "all" || status.split(',').any(|x| a["status"] == x)).cloned().collect())
            })?;
            let (asks, next) = page(items, limit, c.q("cursor"))?;
            let v = json!({"asks": asks, "nextCursor": next});
            validate("method:asks.list", &v);
            Ok((200, v))
        }
        "asks.get" => {
            let v = sh.read(|w| -> ApiResult<Value> { Ok(json!({"ask": w.sess(c.sid())?.ask(c.sub()).cloned().ok_or_else(ask_404)?})) })?;
            validate("method:asks.get", &v);
            Ok((200, v))
        }
        "asks.answer" => answer(sh, c),
        "asks.dismiss" => {
            c.allow(&["message"])?;
            let message = c.bs("message")?;
            let v = sh.with(|w| -> ApiResult<Value> {
                let a = w.sess(c.sid())?.ask(c.sub()).cloned().ok_or_else(ask_404)?;
                if a["status"] != "open" {
                    if a["status"] == "dismissed" && a["closedBy"]["id"] == actor["id"] {
                        return Ok(json!({"ask": a, "seq": seq(w, c.sid())}));
                    }
                    return Err(ApiErr::new(409, "ask_closed", format!("the ask is {}", st(&a, "status"))).with("ask", a));
                }
                let answer = message.map(|m| json!({"message": m})).unwrap_or(Value::Null);
                w.close_ask(c.sid(), c.sub(), "dismissed", Some(actor), answer);
                let s = w.sess(c.sid())?;
                Ok(json!({"ask": s.ask(c.sub()).unwrap(), "seq": s.last_seq()}))
            })?;
            validate("method:asks.dismiss", &v);
            Ok((200, v))
        }
        "subagents.list" => {
            let all = c.q("status").as_deref() == Some("all");
            let limit = c.qn("limit", 1, 100)?.unwrap_or(20) as usize;
            let items = sh.read(|w| -> ApiResult<Vec<Value>> { Ok(w.sess(c.sid())?.subagents.iter().rev().filter(|x| all || x["status"] == "running").cloned().collect()) })?;
            let (subs, next) = page(items, limit, c.q("cursor"))?;
            let v = json!({"subagents": subs, "nextCursor": next});
            validate("method:subagents.list", &v);
            Ok((200, v))
        }
        "subagents.get" => {
            let v = sh.read(|w| -> ApiResult<Value> { Ok(json!({"subagent": w.sess(c.sid())?.subagent(c.sub()).cloned().ok_or_else(sub_404)?})) })?;
            validate("method:subagents.get", &v);
            Ok((200, v))
        }
        "subagents.stop" => {
            let r = sh.with(|w| -> ApiResult<(u16, Value)> {
                let x = w.sess(c.sid())?.subagent(c.sub()).cloned().ok_or_else(sub_404)?;
                if x["status"] != "running" {
                    if x["status"] == "stopped" && x["stoppedBy"]["id"] == actor["id"] {
                        return Ok((200, json!({"subagent": x, "seq": seq(w, c.sid())})));
                    }
                    return Err(ApiErr::new(409, "subagent_ended", format!("the subagent is {}", st(&x, "status"))).with("subagent", x));
                }
                let before = seq(w, c.sid());
                w.end_subagent(c.sid(), c.sub(), "stopped", None, Some(actor));
                Ok((202, json!({"subagent": x, "seq": before})))
            })?;
            validate("method:subagents.stop", &r.1);
            Ok(r)
        }
        other => Err(ApiErr::new(404, "not_found", format!("no operation {other}"))),
    }
}

fn ask_404() -> ApiErr {
    ApiErr::new(404, "ask_not_found", "no such ask")
}
fn sub_404() -> ApiErr {
    ApiErr::new(404, "subagent_not_found", "no such subagent")
}

async fn wait_min_seq(sh: &Arc<Shared>, c: &Call) -> ApiResult<()> {
    sh.read(|w| w.sess(c.sid()).map(|_| ()))?;
    if let Some(min) = c.qn("minSeq", 0, u64::MAX)? {
        let sid = c.sid().to_string();
        let ok = sh.wait_until(Some(Duration::from_secs(2)), move |w| w.sess(&sid).is_ok_and(|s| s.last_seq() >= min)).await;
        if !ok {
            return Err(ApiErr::new(503, "unavailable", format!("seq {min} was not reached in time")).with("retryAfterMs", 100));
        }
    }
    Ok(())
}

async fn create(sh: &Arc<Shared>, c: &Call) -> ApiResult<(u16, Value)> {
    c.allow(&["id", "input", "title", "model", "effort", "speed", "mode", "metadata"])?;
    let id = c.bs("id")?;
    if let Some(id) = &id
        && !valid_session_id(id)
    {
        return Err(ApiErr::bad("id", "id must be cs_ and 16 lowercase Crockford base32 characters"));
    }
    let input = c.bs("input")?;
    if input.as_deref() == Some("") {
        return Err(ApiErr::bad("input", "input must not be empty"));
    }
    let title = c.bs("title")?;
    if title.as_ref().is_some_and(|t| t.chars().count() > 200) {
        return Err(ApiErr::bad("title", "title is longer than 200 characters"));
    }
    let (model, effort, mode) = (c.bs("model")?, c.bs("effort")?, c.bs("mode")?);
    check_settings(&model, &effort, &mode)?;
    let speed = check_speed(c.bs("speed")?)?;
    let metadata = string_map(c.b("metadata"), "metadata")?;
    let metadata: Map<String, Value> = metadata.into_iter().filter(|(_, v)| !v.is_null()).collect();
    let v = sh.with(|w| -> ApiResult<Value> {
        let id = id.clone().unwrap_or_else(|| new_id("cs_"));
        if w.sess(&id).is_ok() {
            return Err(ApiErr::field(409, "id_conflict", "id", format!("{id} already exists")));
        }
        let title = title.clone().filter(|t| !t.is_empty()).unwrap_or_else(|| input.as_ref().map(|i| i.chars().take(60).collect()).unwrap_or_else(|| "New session".into()));
        let via = c.actor["via"].as_str().unwrap_or("api").to_string();
        let origin = json!({"type": via, "client": c.actor["client"], "slack": null});
        let settings = (Some(model.clone().unwrap_or_else(|| "opus-5.5".into())), Some(effort.clone().unwrap_or_else(|| "high".into())), mode.clone().unwrap_or_else(|| "default".into()));
        w.create_session(id.clone(), title, me(), origin, settings, metadata.clone(), Some(&c.actor));
        w.s(&id).speed = speed.clone();
        let (turn, delivery) = match &input {
            Some(i) => {
                let (tid, d) = w.send(&id, i.clone(), "queue", &c.actor)?;
                (w.sess(&id)?.turn(&tid).cloned(), Some(d))
            }
            None => (None, None),
        };
        let s = w.sess(&id)?;
        Ok(json!({"session": s.to_json(), "turn": turn, "delivery": delivery, "duplicate": false, "seq": s.last_seq()}))
    })?;
    if !v["turn"].is_null() {
        validate("Turn", &v["turn"]);
    }
    Ok((201, v))
}

fn list_sessions(sh: &Arc<Shared>, c: &Call) -> ApiResult<(u16, Value)> {
    let owner = c.q("owner").unwrap_or_else(|| "me".into());
    let statuses: Option<Vec<String>> = c.q("status").map(|s| s.split(',').map(str::to_string).collect());
    let origins: Option<Vec<String>> = c.q("origin").map(|s| s.split(',').map(str::to_string).collect());
    let archived = c.q("archived").unwrap_or_else(|| "false".into());
    if !["true", "false", "all"].contains(&archived.as_str()) {
        return Err(ApiErr::bad("archived", "archived is true, false or all"));
    }
    let order = c.q("order").unwrap_or_else(|| "active".into());
    if !["active", "created"].contains(&order.as_str()) {
        return Err(ApiErr::bad("order", "order is active or created"));
    }
    let text = c.q("q").map(|s| s.to_lowercase());
    let limit = c.qn("limit", 1, 100)?.unwrap_or(20) as usize;
    let meta: Vec<(String, String)> = c
        .query
        .iter()
        .filter_map(|(k, v)| Some((k.strip_prefix("metadata[")?.strip_suffix(']')?.to_string(), v.as_str().unwrap_or_default().to_string())))
        .collect();
    let me_id = st(&me(), "id");
    let mut items: Vec<(String, Value)> = sh.read(|w| {
        w.sessions
            .iter()
            .filter(|s| match owner.as_str() {
                "anyone" => true,
                "me" => s.owner["id"] == me_id.as_str(),
                id => s.owner["id"] == id,
            })
            .filter(|s| statuses.as_ref().is_none_or(|l| l.iter().any(|x| x == s.computed_status())))
            .filter(|s| origins.as_ref().is_none_or(|l| l.contains(&st(&s.origin, "type"))))
            .filter(|s| match archived.as_str() {
                "all" => true,
                "true" => s.archived,
                _ => !s.archived,
            })
            .filter(|s| meta.iter().all(|(k, v)| s.metadata.get(k).and_then(Value::as_str) == Some(v.as_str())))
            .filter(|s| text.as_ref().is_none_or(|q| s.title.to_lowercase().contains(q)))
            .map(|s| (if order == "created" { s.created_at.clone() } else { s.last_active_at.clone() }, s.to_json()))
            .collect()
    });
    items.sort_by(|a, b| b.0.cmp(&a.0));
    let (sessions, next) = page(items.into_iter().map(|x| x.1).collect(), limit, c.q("cursor"))?;
    Ok((200, json!({"sessions": sessions, "nextCursor": next})))
}

fn update(sh: &Arc<Shared>, c: &Call) -> ApiResult<(u16, Value)> {
    c.allow(&["title", "model", "effort", "speed", "mode", "archived", "metadata"])?;
    let fields = ["title", "model", "effort", "speed", "mode", "archived", "metadata"];
    if !fields.iter().any(|f| c.body.get(*f).is_some()) {
        return Err(ApiErr::bad("body", "nothing to change"));
    }
    let title = c.bs("title")?;
    if title.as_ref().is_some_and(|t| t.is_empty() || t.chars().count() > 200) {
        return Err(ApiErr::bad("title", "title is 1 to 200 characters"));
    }
    let (model, effort, mode) = (c.bs("model")?, c.bs("effort")?, c.bs("mode")?);
    let speed = check_speed(c.bs("speed")?)?;
    let archived = match c.b("archived") {
        None => None,
        Some(Value::Bool(b)) => Some(*b),
        Some(_) => return Err(ApiErr::bad("archived", "archived is a boolean")),
    };
    let metadata = match c.b("metadata") {
        None => None,
        v => Some(string_map(v, "metadata")?),
    };
    let v = sh.with(|w| -> ApiResult<Value> {
        let s = w.sess(c.sid())?;
        let m = model.clone().or(s.model.clone());
        check_settings(&m, &effort, &mode)?;
        let s = w.s(c.sid());
        let mut changes = Map::new();
        let mut set = |name: &str, from: Value, to: Value| {
            if from != to {
                changes.insert(name.into(), json!({"from": from, "to": to}));
            }
        };
        if let Some(t) = &title {
            set("title", json!(s.title), json!(t));
            s.title = t.clone();
        }
        if let Some(x) = &model {
            set("model", json!(s.model), json!(x));
            s.model = Some(x.clone());
        }
        if let Some(x) = &effort {
            set("effort", json!(s.effort), json!(x));
            s.effort = Some(x.clone());
        }
        if let Some(x) = &speed {
            set("speed", json!(s.speed), json!(x));
            s.speed = Some(x.clone());
        }
        if let Some(x) = &mode {
            set("mode", json!(s.mode), json!(x));
            s.mode = x.clone();
        }
        if let Some(a) = archived {
            set("archived", json!(s.archived), json!(a));
            s.archived = a;
        }
        if let Some(m) = &metadata {
            let from = Value::Object(s.metadata.clone());
            for (k, v) in m {
                if v.is_null() {
                    s.metadata.remove(k);
                } else {
                    s.metadata.insert(k.clone(), v.clone());
                }
            }
            set("metadata", from, Value::Object(s.metadata.clone()));
        }
        if !changes.is_empty() {
            w.emit(c.sid(), None, "session.updated", Some(&c.actor), json!({"changes": changes}));
        }
        let s = w.sess(c.sid())?;
        Ok(json!({"session": s.to_json(), "seq": s.last_seq()}))
    })?;
    validate("method:sessions.update", &v);
    Ok((200, v))
}

async fn events_list(sh: &Arc<Shared>, c: &Call) -> ApiResult<(u16, Value)> {
    let after = c.qn("after", 0, u64::MAX)?;
    let tail = c.qn("tailTurns", 1, 50)?;
    if after.is_some() && tail.is_some() {
        return Err(ApiErr::bad("tailTurns", "tailTurns cannot be combined with after"));
    }
    let limit = c.qn("limit", 1, 500)?.unwrap_or(100) as usize;
    let wait = c.qn("waitMs", 0, 60000)?.unwrap_or(0);
    let turn_id = c.q("turnId");
    let types: Option<Vec<String>> = c.q("types").map(|s| s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect());
    let after_n = after.unwrap_or(0);
    let last = sh.read(|w| w.sess(c.sid()).map(|s| s.last_seq()))?;
    if after_n > last {
        let session = sh.read(|w| w.sess(c.sid()).map(|s| s.to_json()))?;
        return Err(ApiErr::new(409, "cursor_ahead", format!("after {after_n} is past lastSeq {last}")).with("session", session));
    }
    let matches = move |ev: &Value| -> bool {
        turn_id.as_ref().is_none_or(|t| ev["turnId"] == t.as_str())
            && types.as_ref().is_none_or(|l| {
                let ty = ev["type"].as_str().unwrap_or("");
                l.iter().any(|p| match p.strip_suffix('*') {
                    Some(prefix) => ty.starts_with(prefix),
                    None => ty == p,
                })
            })
    };
    if wait > 0 && tail.is_none() {
        let sid = c.sid().to_string();
        let m = matches.clone();
        sh.wait_until(Some(Duration::from_millis(wait)), move |w| w.sess(&sid).is_ok_and(|s| s.events.iter().skip(after_n as usize).any(&m))).await;
    }
    let v = sh.read(|w| -> ApiResult<Value> {
        let s = w.sess(c.sid())?;
        let (from_seq, earlier) = match tail {
            Some(n) => tail_split(s, n as usize),
            None => (after_n + 1, Value::Null),
        };
        let candidates: Vec<&Value> = s.events.iter().skip(from_seq.saturating_sub(1) as usize).filter(|e| matches(e)).collect();
        let has_more = candidates.len() > limit;
        let events: Vec<Value> = candidates.into_iter().take(limit).cloned().collect();
        Ok(json!({"events": events, "earlierTurns": earlier, "lastSeq": s.last_seq(), "hasMore": has_more}))
    })?;
    validate("method:events.list", &v);
    Ok((200, v))
}

/// `tailTurns`: the first seq of the last `n` turns, and the turns before them, newest first.
pub fn tail_split(s: &Sess, n: usize) -> (u64, Value) {
    let started: Vec<&Value> = s.turns.iter().filter(|t| !t["startedAt"].is_null() || t["status"] != "queued").collect();
    if started.len() <= n {
        return (1, json!([]));
    }
    let tail_first = &started[started.len() - n];
    let first_seq = s.events.iter().find(|e| e["turnId"] == tail_first["id"]).and_then(|e| e["seq"].as_u64()).unwrap_or(1);
    let earlier: Vec<Value> = started[..started.len() - n].iter().rev().take(50).map(|t| (*t).clone()).collect();
    (first_seq, Value::Array(earlier))
}

fn answer(sh: &Arc<Shared>, c: &Call) -> ApiResult<(u16, Value)> {
    let v = sh.with(|w| -> ApiResult<Value> {
        let a = w.sess(c.sid())?.ask(c.sub()).cloned().ok_or_else(ask_404)?;
        let kind = st(&a, "kind");
        if kind == "secret" {
            return Err(ApiErr::new(400, "answer_with_secret", "a secret request is answered in Slack").with("name", a["secret"]["name"].clone()));
        }
        let body = &c.body;
        let mut mode_change = None;
        match kind.as_str() {
            "approval" => {
                c.allow(&["decision", "message", "mode"])?;
                let d = body["decision"].as_str().unwrap_or("");
                if !["allow", "deny", "always"].contains(&d) {
                    return Err(ApiErr::field(400, "invalid_answer", "decision", "decision is allow, deny or always"));
                }
                if d == "always" && a["approval"]["alwaysAllows"].is_null() {
                    return Err(ApiErr::field(400, "invalid_answer", "decision", "this approval has no always option"));
                }
                if let Some(m) = body.get("mode").filter(|m| !m.is_null()) {
                    // A plan approval may switch the permission mode.
                    let m = m.as_str().ok_or_else(|| ApiErr::field(400, "invalid_answer", "mode", "mode is a string"))?;
                    if a["approval"]["toolName"] != "ExitPlanMode" {
                        return Err(ApiErr::field(400, "invalid_answer", "mode", "mode applies to plan approvals only"));
                    }
                    check_settings(&None, &None, &Some(m.to_string())).map_err(|e| ApiErr::field(400, "invalid_answer", "mode", e.message))?;
                    if d != "deny" {
                        mode_change = Some(m.to_string());
                    }
                } else if d != "deny" && a["approval"]["toolName"] == "ExitPlanMode" && w.sess(c.sid())?.mode == "plan" {
                    // Allowing a plan without a mode leaves plan mode for `default`.
                    mode_change = Some("default".into());
                }
            }
            "question" => {
                c.allow(&["answers"])?;
                let Some(answers) = body["answers"].as_array() else {
                    return Err(ApiErr::field(400, "invalid_answer", "answers", "answers is required"));
                };
                for ans in answers {
                    let qid = ans["questionId"].as_str().unwrap_or("");
                    let Some(q) = a["question"]["questions"].as_array().unwrap().iter().find(|q| q["id"] == qid) else {
                        return Err(ApiErr::field(400, "invalid_answer", "answers", format!("no question {qid}")));
                    };
                    for ch in ans["choices"].as_array().cloned().unwrap_or_default() {
                        if !q["options"].as_array().unwrap().iter().any(|o| o["label"] == ch) {
                            return Err(ApiErr::field(400, "invalid_answer", "answers", format!("{ch} is not an option")));
                        }
                    }
                }
            }
            _ => {}
        }
        if a["status"] != "open" {
            if a["status"] == "answered" && a["closedBy"]["id"] == c.actor["id"] && canonical(&a["answer"]) == canonical(body) {
                return Ok(json!({"ask": a, "seq": seq(w, c.sid())}));
            }
            return Err(ApiErr::new(409, "ask_closed", format!("the ask is {}", st(&a, "status"))).with("ask", a));
        }
        w.close_ask(c.sid(), c.sub(), "answered", Some(&c.actor), body.clone());
        if let Some(m) = mode_change {
            let s = w.s(c.sid());
            let from = std::mem::replace(&mut s.mode, m.clone());
            if from != m {
                w.emit(c.sid(), None, "session.updated", Some(&c.actor), json!({"changes": {"mode": {"from": from, "to": m}}}));
            }
        }
        let s = w.sess(c.sid())?;
        Ok(json!({"ask": s.ask(c.sub()).unwrap(), "seq": s.last_seq()}))
    })?;
    validate("method:asks.answer", &v);
    Ok((200, v))
}

