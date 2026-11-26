//! An in-process fake Computer for opc's integration tests.
//!
//! `Fake::start()` runs the HTTP API (under `/api/managed-agents/computer`),
//! the device login routes at the host root, and the `opc.v1` WebSocket at
//! `/v1`, all on one `127.0.0.1` port, on a runtime of its own. Every object
//! it sends is checked against `schema/computer-api.v1.json`: an invalid one
//! panics the server task and fails the test that caused it.
//!
//! `fake.opc()` is an `assert_cmd::Command` for the opc binary with its
//! environment pointed at the fake and at temporary config, state and home.
//!
//! The agent is scripted by the turn's input:
//!
//! | Input | What the agent does |
//! | --- | --- |
//! | `reply <text>` | Streams `<text>` as `message.delta`s, then completes with it |
//! | `silent` | Completes with `text: null` and `silent: true` |
//! | `fail [message]` | `turn.failed` with `agent_failed` |
//! | `slow <ms>` | Waits, then replies `done after <ms> ms` |
//! | `tool` | Bash `echo hi`: `tool.preparing` (delta), `tool.started`, `tool.delta`, `tool.completed`, then `tool done` |
//! | `approve [once]` | An approval ask for Bash (`once`: no always option). Replies `approval: <decision>`, or `approval: <status> (<message>)` when it closed another way |
//! | `plan` | An ExitPlanMode approval, replied the same way |
//! | `question` | A question ask `q1` "Color" with `red`, `blue`. Replies `answer: <choices>` |
//! | `secret NAME` | A secret ask. Replies `secret NAME: <status>` |
//! | `subagent fg <ms>` | A foreground subagent with a nested Read call, ending `found 3 things` |
//! | `subagent bg <ms>` | A background subagent; when it ends after `<ms>`, the agent takes a turn of its own (`trigger: subagent`, `input: null`) |
//! | `/compact [...]` | (from `POST /compact`) `session.compacting` delta, `session.compacted`, completes with `text: null` |
//! | anything else | Replies `You said: <input>` |

#![allow(dead_code, clippy::result_large_err)]

mod agent;
mod api;
mod http;
pub mod model;
mod schema;
mod workspace;
mod ws;

#[allow(unused_imports)]
pub use api::Call;
#[allow(unused_imports)]
pub use model::{ApiErr, me, other_person};
#[allow(unused_imports)]
pub use schema::{check, validate};

use model::{Shared, World, actor_of, new_id};
use serde_json::{Map, Value, json};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;
use tokio::sync::{broadcast, watch};

pub const API_PREFIX: &str = "/api/managed-agents/computer";
pub const TEST_KEY: &str = "opc_test_key_0000000000000000";

/// One HTTP request the fake received.
#[derive(Debug, Clone)]
pub struct LoggedRequest {
    pub method: String,
    /// The path without the query, relative to the API prefix (`/sessions/cs_…/turns`),
    /// or from the host root for routes outside it (`/auth/cli/device`).
    pub path: String,
    pub query: String,
    /// Lowercased names.
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub status: u16,
}

impl LoggedRequest {
    pub fn header(&self, name: &str) -> Option<&str> {
        let name = name.to_ascii_lowercase();
        self.headers.iter().find(|(k, _)| *k == name).map(|(_, v)| v.as_str())
    }
    pub fn idempotency_key(&self) -> Option<&str> {
        self.header("idempotency-key")
    }
    pub fn json(&self) -> Value {
        serde_json::from_slice(&self.body).unwrap_or(Value::Null)
    }
    /// `"POST /sessions/cs_…/turns"`.
    pub fn route(&self) -> String {
        format!("{} {}", self.method, self.path)
    }
    /// The decoded value of a query parameter (the first, when repeated).
    pub fn query_param(&self, name: &str) -> Option<String> {
        http::parse_query(&self.query).into_iter().find(|(k, _)| k == name).map(|(_, v)| v)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Dir {
    In,
    Out,
}

/// One WebSocket frame, in (from the client) or out (from the fake).
#[derive(Debug, Clone)]
pub struct WsFrame {
    /// Connection number, from 1.
    pub conn: u64,
    pub dir: Dir,
    pub text: Option<String>,
    pub binary: Option<Vec<u8>>,
}

impl WsFrame {
    pub fn json(&self) -> Value {
        self.text.as_deref().and_then(|t| serde_json::from_str(t).ok()).unwrap_or(Value::Null)
    }
    /// The JSON-RPC method of a request or notification.
    pub fn method(&self) -> Option<String> {
        self.json()["method"].as_str().map(str::to_string)
    }
}

/// A canned failure for requests matching a pattern.
#[derive(Debug, Clone)]
pub struct Failure {
    pub status: u16,
    pub code: String,
    pub message: String,
    pub extra: Map<String, Value>,
    /// Extra response headers, such as `Retry-After`.
    pub headers: Vec<(String, String)>,
}

impl Failure {
    pub fn new(status: u16, code: &str) -> Self {
        Failure { status, code: code.into(), message: format!("injected {code}"), extra: Map::new(), headers: vec![] }
    }
    pub fn with(mut self, k: &str, v: impl Into<Value>) -> Self {
        self.extra.insert(k.into(), v.into());
        self
    }
    pub fn message(mut self, m: &str) -> Self {
        self.message = m.into();
        self
    }
    pub fn rate_limited(retry_after_ms: u64) -> Self {
        let mut f = Self::new(429, "rate_limited").with("retryAfterMs", retry_after_ms);
        f.headers.push(("retry-after".into(), retry_after_ms.div_ceil(1000).to_string()));
        f
    }
    pub fn unavailable(retry_after_ms: u64) -> Self {
        Self::new(503, "unavailable").with("retryAfterMs", retry_after_ms)
    }
    pub fn unauthenticated() -> Self {
        Self::new(401, "unauthenticated")
    }
    pub fn insufficient_credits() -> Self {
        Self::new(402, "insufficient_credits")
    }
    pub fn forbidden(reason: &str) -> Self {
        Self::new(403, "forbidden").with("reason", reason)
    }
    pub fn upgrade_required(min_version: &str) -> Self {
        Self::new(426, "upgrade_required").with("minVersion", min_version)
    }
    pub fn session_not_found() -> Self {
        Self::new(404, "session_not_found")
    }
    pub fn internal() -> Self {
        Self::new(500, "internal")
    }
    pub(crate) fn to_err(&self) -> ApiErr {
        let mut e = ApiErr::new(self.status, &self.code, self.message.clone());
        e.extra = self.extra.clone();
        e
    }
}

#[derive(Debug, Clone)]
pub struct Injected {
    pub pattern: String,
    pub failure: Failure,
    pub remaining: u32,
}

/// Behaviour switches. Change them with the `Fake` setters, or lock `fake.sh.knobs`.
#[derive(Debug, Clone)]
pub struct Knobs {
    /// The key requests must carry (`Authorization: Bearer` or `x-api-key`).
    pub key: String,
    pub revoked: bool,
    pub failures: Vec<Injected>,
    /// Pattern and delay before the request is handled.
    pub delays: Vec<(String, Duration)>,
    /// Sent as `x-opc-latest` on every response.
    pub latest: Option<String>,
    /// `false`: `/me` has `wireUrl: null` and upgrades get 404.
    pub ws_enabled: bool,
    /// Accept the upgrade, then close at once with this code and reason.
    pub ws_refuse: Option<(u16, String)>,
    /// Drop the next connection (no close frame) after it has sent this many frames.
    pub ws_drop_after: Option<usize>,
    /// When `true`, an interrupt leaves background subagents running (the docs);
    /// when `false` (the default) they stop, as the server does today.
    pub interrupt_spares_background: bool,
    /// How many exchange polls answer `authorization_pending` before `authorized`.
    pub device_pending: u32,
    /// Time between the scripted agent's steps.
    pub step_ms: u64,
    /// `computer.status` in `/me`.
    pub computer_status: String,
}

impl Default for Knobs {
    fn default() -> Self {
        Knobs {
            key: TEST_KEY.into(),
            revoked: false,
            failures: vec![],
            delays: vec![],
            latest: None,
            ws_enabled: true,
            ws_refuse: None,
            ws_drop_after: None,
            interrupt_spares_background: false,
            device_pending: 1,
            step_ms: 5,
            computer_status: "ready".into(),
        }
    }
}

/// Matches `"METHOD /path/*/x"` against a method and path (`*` is one segment),
/// or `"ws method"` against a WebSocket method (`method` is `"ws"`).
pub fn pattern_matches(pattern: &str, method: &str, path: &str) -> bool {
    let Some((pm, pp)) = pattern.split_once(' ') else { return false };
    if !pm.eq_ignore_ascii_case(method) {
        return false;
    }
    if method == "ws" {
        return pp == path || pp == "*";
    }
    let a: Vec<&str> = pp.trim_matches('/').split('/').collect();
    let b: Vec<&str> = path.trim_matches('/').split('/').collect();
    if a.last() == Some(&"**") {
        return b.len() >= a.len() - 1 && a[..a.len() - 1].iter().zip(&b).all(|(x, y)| *x == "*" || x == y);
    }
    a.len() == b.len() && a.iter().zip(&b).all(|(x, y)| *x == "*" || x == y)
}

/// Options for [`Fake::seed_session`].
#[derive(Debug, Clone)]
pub struct Seed {
    pub id: Option<String>,
    pub title: String,
    pub owner: Value,
    pub slack: Option<(String, String)>,
    pub metadata: Map<String, Value>,
    pub archived: bool,
    pub model: String,
    pub effort: String,
    pub mode: String,
    pub suspended: bool,
    /// Turns to run to completion before returning, as messages from the owner.
    pub turns: Vec<String>,
}

impl Default for Seed {
    fn default() -> Self {
        Seed {
            id: None,
            title: "Seeded session".into(),
            owner: me(),
            slack: None,
            metadata: Map::new(),
            archived: false,
            model: "opus-5.5".into(),
            effort: "high".into(),
            mode: "default".into(),
            suspended: false,
            turns: vec![],
        }
    }
}

impl Seed {
    pub fn new(title: &str) -> Self {
        Seed { title: title.into(), ..Default::default() }
    }
    pub fn id(mut self, id: &str) -> Self {
        self.id = Some(id.into());
        self
    }
    pub fn owner(mut self, person: Value) -> Self {
        self.owner = person;
        self
    }
    /// Started from Slack, in `channel`, thread `ts`.
    pub fn slack(mut self, channel: &str, ts: &str) -> Self {
        self.slack = Some((channel.into(), ts.into()));
        self
    }
    pub fn meta(mut self, k: &str, v: &str) -> Self {
        self.metadata.insert(k.into(), v.into());
        self
    }
    pub fn archived(mut self) -> Self {
        self.archived = true;
        self
    }
    pub fn mode(mut self, mode: &str) -> Self {
        self.mode = mode.into();
        self
    }
    pub fn model(mut self, model: &str, effort: &str) -> Self {
        self.model = model.into();
        self.effort = effort.into();
        self
    }
    pub fn suspended(mut self) -> Self {
        self.suspended = true;
        self
    }
    pub fn turn(mut self, input: &str) -> Self {
        self.turns.push(input.into());
        self
    }
}

pub struct Fake {
    pub sh: Arc<Shared>,
    /// `http://127.0.0.1:<port>`: what `OPENCOMPUTER_API_URL` is set to.
    pub url: String,
    /// `ws://127.0.0.1:<port>/v1`.
    pub wire_url: String,
    pub home: tempfile::TempDir,
    workspace: tempfile::TempDir,
    port: u16,
    stop: Option<tokio::sync::oneshot::Sender<()>>,
    thread: Option<std::thread::JoinHandle<()>>,
}

impl Fake {
    pub fn start() -> Fake {
        let home = tempfile::tempdir().expect("tempdir");
        let workspace = tempfile::tempdir().expect("tempdir");
        install_panic_hook();
        let std_listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind");
        std_listener.set_nonblocking(true).unwrap();
        let port = std_listener.local_addr().unwrap().port();
        // The runtime is built and driven on a thread of its own, so `start()`
        // works from inside a `#[tokio::test]` too.
        let (rt_tx, rt_rx) = std::sync::mpsc::channel();
        let (stop_tx, stop_rx) = tokio::sync::oneshot::channel::<()>();
        let (go_tx, go_rx) = tokio::sync::oneshot::channel::<Arc<Shared>>();
        let thread = std::thread::spawn(move || {
            let rt = tokio::runtime::Builder::new_multi_thread().worker_threads(2).thread_name(format!("opc-fake-{port}")).enable_all().build().expect("runtime");
            rt_tx.send(rt.handle().clone()).unwrap();
            rt.block_on(async move {
                let listener = tokio::net::TcpListener::from_std(std_listener).expect("listener");
                let Ok(sh) = go_rx.await else { return };
                tokio::select! {
                    _ = http::serve(listener, sh) => {}
                    _ = stop_rx => {}
                }
            });
            rt.shutdown_timeout(Duration::from_millis(100));
        });
        let handle = rt_rx.recv().expect("runtime");
        let url = format!("http://127.0.0.1:{port}");
        let wire_url = format!("ws://127.0.0.1:{port}/v1");
        let (bus, _) = broadcast::channel(65536);
        let (ctl, _) = broadcast::channel(64);
        let world = World { sessions: vec![], idem: Default::default(), jobs: vec![], bus: bus.clone(), interrupt_spares_background: false };
        let sh = Arc::new(Shared {
            world: Mutex::new(world),
            version: watch::channel(0).0,
            bus,
            ctl,
            knobs: Mutex::new(Knobs::default()),
            requests: Mutex::new(vec![]),
            frames: Mutex::new(vec![]),
            handle,
            workspace_root: workspace.path().to_path_buf(),
            api_url: url.clone(),
            wire_url: wire_url.clone(),
            ws_connections: Mutex::new(0),
        });
        let _ = go_tx.send(sh.clone());
        Fake { sh, url, wire_url, home, workspace, port, stop: Some(stop_tx), thread: Some(thread) }
    }

    /// Panics raised on the fake's threads so far, such as schema violations.
    pub fn panics(&self) -> Vec<String> {
        let name = format!("opc-fake-{}", self.port);
        PANICS.lock().unwrap().iter().filter(|(t, _)| *t == name).map(|(_, m)| m.clone()).collect()
    }

    /// Fails the test if anything on the fake's threads panicked.
    pub fn assert_no_panics(&self) {
        let p = self.panics();
        assert!(p.is_empty(), "the fake server panicked: {p:#?}");
    }

    pub fn api_base(&self) -> String {
        format!("{}{API_PREFIX}", self.url)
    }

    /// The opc binary, with its environment pointed at this fake.
    pub fn opc(&self) -> assert_cmd::Command {
        let mut c = assert_cmd::Command::new(env!("CARGO_BIN_EXE_opc"));
        for (k, v) in self.env() {
            c.env(k, v);
        }
        c.env_remove("OPC_LOG").env_remove("HTTPS_PROXY").env_remove("https_proxy").env_remove("ALL_PROXY");
        c.timeout(Duration::from_secs(30));
        c
    }

    /// The environment `opc()` sets, for tests that build their own command.
    pub fn env(&self) -> Vec<(String, String)> {
        let h = self.home.path();
        vec![
            ("OPENCOMPUTER_API_URL".into(), self.url.clone()),
            ("OPENCOMPUTER_API_KEY".into(), self.sh.knobs.lock().unwrap().key.clone()),
            ("OPC_WIRE_URL".into(), self.wire_url.clone()),
            ("OPC_STATE_DIR".into(), h.join("state").display().to_string()),
            ("OPENCOMPUTER_CONFIG".into(), h.join("config.json").display().to_string()),
            ("HOME".into(), h.display().to_string()),
            ("XDG_CONFIG_HOME".into(), h.join(".config").display().to_string()),
            ("XDG_STATE_HOME".into(), h.join(".local/state").display().to_string()),
            ("XDG_CACHE_HOME".into(), h.join(".cache").display().to_string()),
            ("NO_COLOR".into(), "1".into()),
            ("NO_PROXY".into(), "127.0.0.1,localhost".into()),
        ]
    }

    // ----- Observation -----

    /// Every HTTP request so far, oldest first.
    pub fn requests(&self) -> Vec<LoggedRequest> {
        self.sh.requests.lock().unwrap().clone()
    }
    /// Requests whose route matches a pattern such as `"POST /sessions/*/turns"`.
    pub fn requests_to(&self, pattern: &str) -> Vec<LoggedRequest> {
        self.requests().into_iter().filter(|r| pattern_matches(pattern, &r.method, &r.path)).collect()
    }
    pub fn clear_requests(&self) {
        self.sh.requests.lock().unwrap().clear();
    }
    /// Every WebSocket frame so far, both directions.
    pub fn ws_frames(&self) -> Vec<WsFrame> {
        self.sh.frames.lock().unwrap().clone()
    }
    /// JSON-RPC requests received, as `(method, params)`.
    pub fn ws_calls(&self) -> Vec<(String, Value)> {
        self.ws_frames()
            .into_iter()
            .filter(|f| f.dir == Dir::In)
            .filter_map(|f| {
                let v = f.json();
                Some((v["method"].as_str()?.to_string(), v["params"].clone()))
            })
            .collect()
    }
    /// How many WebSocket connections were accepted.
    pub fn ws_connections(&self) -> u64 {
        *self.sh.ws_connections.lock().unwrap()
    }
    /// The session as `GET /sessions/{id}` would return it.
    pub fn session(&self, sid: &str) -> Value {
        self.sh.read(|w| w.sess(sid).map(|s| s.to_json())).expect("no such session")
    }
    pub fn session_ids(&self) -> Vec<String> {
        self.sh.read(|w| w.sessions.iter().map(|s| s.id.clone()).collect())
    }
    /// Every recorded event of a session.
    pub fn events(&self, sid: &str) -> Vec<Value> {
        self.sh.read(|w| w.sess(sid).map(|s| s.events.clone())).expect("no such session")
    }
    /// The recorded events of one type.
    pub fn events_of(&self, sid: &str, ty: &str) -> Vec<Value> {
        self.events(sid).into_iter().filter(|e| e["type"] == ty).collect()
    }
    pub fn turns(&self, sid: &str) -> Vec<Value> {
        self.sh.read(|w| w.sess(sid).map(|s| s.turns.clone())).expect("no such session")
    }
    pub fn turn(&self, sid: &str, tid: &str) -> Value {
        self.sh.read(|w| w.sess(sid).ok().and_then(|s| s.turn(tid).cloned())).expect("no such turn")
    }
    pub fn asks(&self, sid: &str) -> Vec<Value> {
        self.sh.read(|w| w.sess(sid).map(|s| s.asks.clone())).expect("no such session")
    }
    pub fn subagents(&self, sid: &str) -> Vec<Value> {
        self.sh.read(|w| w.sess(sid).map(|s| s.subagents.clone())).expect("no such session")
    }
    /// Read anything under the lock.
    pub fn read<R>(&self, f: impl FnOnce(&World) -> R) -> R {
        self.sh.read(f)
    }

    // ----- Driving it from the test, as another client would -----

    /// Seeds a session directly, recording `session.created`, and runs `seed.turns` to completion.
    pub fn seed_session(&self, seed: Seed) -> String {
        let id = seed.id.clone().unwrap_or_else(|| new_id("cs_"));
        let origin = match &seed.slack {
            Some((ch, ts)) => json!({"type": "slack", "client": null, "slack": {"teamId": "T0TEST", "channelId": ch, "threadTs": ts, "url": format!("https://acme.slack.com/archives/{ch}/p{}", ts.replace('.', ""))}}),
            None => json!({"type": "opc", "client": "opc/0.1.0", "slack": null}),
        };
        let via = if seed.slack.is_some() { "slack" } else { "opc" };
        let actor = actor_of(&seed.owner, via, None);
        self.sh.with(|w| {
            w.create_session(id.clone(), seed.title.clone(), seed.owner.clone(), origin, (Some(seed.model.clone()), Some(seed.effort.clone()), seed.mode.clone()), seed.metadata.clone(), Some(&actor));
            let s = w.s(&id);
            s.archived = seed.archived;
        });
        for t in &seed.turns {
            let (tid, _) = self.send_as(&id, t, "queue", &actor).expect("seed turn");
            assert!(self.wait_turn(&id, &tid, Duration::from_secs(10)), "seeded turn {t:?} did not finish");
        }
        if seed.suspended {
            self.sh.with(|w| {
                w.s(&id).suspended = true;
                w.emit(&id, None, "runtime.suspended", None, json!({"reason": "idle"}));
            });
        }
        id
    }

    /// Sends a message as the test user from the dashboard. Returns (turn id, delivery).
    pub fn send(&self, sid: &str, input: &str, if_busy: &str) -> Result<(String, String), ApiErr> {
        self.send_as(sid, input, if_busy, &actor_of(&me(), "dashboard", None))
    }

    pub fn send_as(&self, sid: &str, input: &str, if_busy: &str, actor: &Value) -> Result<(String, String), ApiErr> {
        let v = self.call(Call { op: "turns.send".into(), sid: Some(sid.into()), body: json!({"input": input, "ifBusy": if_busy}), actor: actor.clone(), ..Default::default() })?;
        Ok((v["turn"]["id"].as_str().unwrap().to_string(), v["delivery"].as_str().unwrap().to_string()))
    }

    /// Runs any operation (the names in `api.rs`, such as `asks.answer`) as the dashboard would.
    pub fn call(&self, mut call: Call) -> Result<Value, ApiErr> {
        if call.actor.is_null() {
            call.actor = actor_of(&me(), "dashboard", None);
        }
        let sh = self.sh.clone();
        self.block(async move { api::dispatch(&sh, call).await.map(|(_, v)| v) })
    }

    /// Answers an ask as another client would.
    pub fn answer(&self, sid: &str, ask_id: &str, answer: Value) -> Result<Value, ApiErr> {
        self.call(Call { op: "asks.answer".into(), sid: Some(sid.into()), sub: Some(ask_id.into()), body: answer, ..Default::default() })
    }

    /// Waits until `cond` holds, up to `timeout`. Returns whether it held.
    pub fn wait_for(&self, timeout: Duration, cond: impl FnMut(&World) -> bool + Send + 'static) -> bool {
        let sh = self.sh.clone();
        self.block(async move { sh.wait_until(Some(timeout), cond).await })
    }

    /// Waits for a turn to end (completed, failed or cancelled).
    pub fn wait_turn(&self, sid: &str, tid: &str, timeout: Duration) -> bool {
        let (sid, tid) = (sid.to_string(), tid.to_string());
        self.wait_for(timeout, move |w| {
            w.sess(&sid).ok().and_then(|s| s.turn(&tid)).is_some_and(|t| matches!(t["status"].as_str(), Some("completed" | "failed" | "cancelled")))
        })
    }

    /// Waits for the session to have nothing running or queued.
    pub fn wait_idle(&self, sid: &str, timeout: Duration) -> bool {
        let sid = sid.to_string();
        self.wait_for(timeout, move |w| w.sess(&sid).is_ok_and(|s| s.active().is_none() && s.queued_ids().is_empty()))
    }

    /// Waits for a recorded event of type `ty`, and returns the first one.
    pub fn wait_event(&self, sid: &str, ty: &str, timeout: Duration) -> Option<Value> {
        let (s2, t2) = (sid.to_string(), ty.to_string());
        self.wait_for(timeout, move |w| w.sess(&s2).is_ok_and(|s| s.events.iter().any(|e| e["type"] == t2.as_str())));
        self.events_of(sid, ty).into_iter().next()
    }

    /// Waits for an open ask and returns it.
    pub fn wait_ask(&self, sid: &str, timeout: Duration) -> Option<Value> {
        let s2 = sid.to_string();
        self.wait_for(timeout, move |w| w.sess(&s2).is_ok_and(|s| !s.open_asks().is_empty()));
        self.asks(sid).into_iter().find(|a| a["status"] == "open")
    }

    /// The session's workspace directory on this machine (created on first use,
    /// with one repository `billing-service` holding `README.md`).
    pub fn workspace(&self, sid: &str) -> PathBuf {
        workspace::dir(&self.sh, sid)
    }

    // ----- Knobs -----

    pub fn knobs(&self) -> std::sync::MutexGuard<'_, Knobs> {
        self.sh.knobs.lock().unwrap()
    }
    /// Fail the next `times` requests matching `pattern` (`"POST /sessions/*/turns"`, `"ws turns.send"`).
    pub fn fail_next(&self, pattern: &str, times: u32, failure: Failure) {
        self.knobs().failures.push(Injected { pattern: pattern.into(), failure, remaining: times });
    }
    /// Delay every request matching `pattern` (also `"ws <method>"`).
    pub fn delay(&self, pattern: &str, d: Duration) {
        self.knobs().delays.push((pattern.into(), d));
    }
    pub fn set_latest_version(&self, v: Option<&str>) {
        self.knobs().latest = v.map(str::to_string);
    }
    pub fn set_ws_enabled(&self, on: bool) {
        self.knobs().ws_enabled = on;
    }
    /// Accept upgrades and close them at once with `code` (`4503` takes a JSON reason).
    pub fn refuse_ws(&self, close: Option<(u16, &str)>) {
        self.knobs().ws_refuse = close.map(|(c, r)| (c, r.to_string()));
    }
    /// Drop the next connection, without a close frame, after it sent `frames` frames.
    pub fn drop_ws_after(&self, frames: usize) {
        self.knobs().ws_drop_after = Some(frames);
    }
    /// Close every open connection now. `None` drops them without a close frame.
    pub fn drop_ws_now(&self, close: Option<(u16, &str)>) {
        let _ = self.sh.ctl.send(close.map(|(c, r)| (c, r.to_string())).unwrap_or((0, String::new())));
    }
    pub fn set_key(&self, key: &str) {
        self.knobs().key = key.into();
    }
    pub fn revoke_key(&self) {
        self.knobs().revoked = true;
    }
    pub fn set_interrupt_spares_background(&self, on: bool) {
        self.knobs().interrupt_spares_background = on;
    }
    pub fn set_device_pending(&self, polls: u32) {
        self.knobs().device_pending = polls;
    }
    pub fn set_step_ms(&self, ms: u64) {
        self.knobs().step_ms = ms;
    }
    pub fn set_computer_status(&self, status: &str) {
        self.knobs().computer_status = status.into();
    }

    /// Runs a future on the fake's runtime and waits for it, from sync or async code.
    fn block<T: Send + 'static>(&self, fut: impl std::future::Future<Output = T> + Send + 'static) -> T {
        let (tx, rx) = std::sync::mpsc::channel();
        self.sh.handle.spawn(async move {
            let _ = tx.send(fut.await);
        });
        rx.recv().expect("the fake's runtime stopped")
    }

    pub fn home(&self) -> &Path {
        self.home.path()
    }
}

impl Drop for Fake {
    fn drop(&mut self) {
        if let Some(s) = self.stop.take() {
            let _ = s.send(());
        }
        if let Some(t) = self.thread.take() {
            let _ = t.join();
        }
        if !std::thread::panicking() {
            self.assert_no_panics();
        }
    }
}

static PANICS: Mutex<Vec<(String, String)>> = Mutex::new(Vec::new());

/// Records panics on the fake's threads, so a schema violation in a server task
/// fails the test even though tokio catches it.
fn install_panic_hook() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let prev = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            if let Some(name) = std::thread::current().name()
                && name.starts_with("opc-fake-")
            {
                let msg = info.payload().downcast_ref::<String>().cloned().or_else(|| info.payload().downcast_ref::<&str>().map(|s| s.to_string())).unwrap_or_default();
                PANICS.lock().unwrap().push((name.to_string(), msg));
            }
            prev(info);
        }));
    });
}
