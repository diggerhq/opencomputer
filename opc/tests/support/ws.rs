//! The `opc.v1` WebSocket: upgrade, `ready`, JSON-RPC methods over the
//! shared operations, terminals over binary frames, and the drop knobs.
//! Watching a session is the live socket's (`live.rs`).

use super::api::{self, Call};
use super::http::{Resp, key_ok, request_actor, request_key, take_failure};
use super::model::{ApiErr, Shared, new_id};
use super::schema::validate;
use super::{Dir, WsFrame, pattern_matches, workspace};
use bytes::Bytes;
use futures_util::stream::SplitSink;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::upgrade::Upgraded;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{Map, Value, json};
use std::collections::HashMap;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, Instant};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::sync::{mpsc, oneshot};
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};

type Ws = WebSocketStream<TokioIo<Upgraded>>;

/// Methods the fake answers that map onto the shared operations.
const API_METHODS: &[&str] = &[
    "sessions.get",
    "sessions.update",
    "sessions.interrupt",
    "sessions.compact",
    "sessions.suspend",
    "sessions.resume",
    "turns.send",
    "turns.get",
    "turns.cancel",
    "asks.list",
    "asks.get",
    "asks.answer",
    "asks.dismiss",
    "subagents.list",
    "subagents.get",
    "subagents.stop",
    "events.list",
];

const WRITES: &[&str] = &["sessions.update", "sessions.interrupt", "sessions.compact", "sessions.suspend", "sessions.resume", "turns.send", "turns.cancel", "asks.answer", "asks.dismiss", "subagents.stop"];

fn plain(status: u16, body: &str) -> Resp {
    Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(body.to_string()))).unwrap()
}

pub async fn upgrade(sh: Arc<Shared>, req: Request<Incoming>, headers: Vec<(String, String)>) -> Resp {
    let (enabled, refuse_knob, drop_after) = {
        let mut k = sh.knobs.lock().unwrap();
        (k.ws_enabled, k.ws_refuse.clone(), k.ws_drop_after.take())
    };
    if !enabled {
        return plain(404, r#"{"error":{"code":"not_found","message":"no WebSocket here","retryable":false}}"#);
    }
    let get = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let Some(key) = get("sec-websocket-key") else {
        return plain(400, r#"{"error":{"code":"invalid_request","message":"not a WebSocket upgrade","retryable":false}}"#);
    };
    let protos: Vec<String> = get("sec-websocket-protocol").map(|p| p.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default();
    let has_v1 = protos.iter().any(|p| p == "opc.v1");
    let ticket = protos.iter().find_map(|p| p.strip_prefix("opc.ticket.")).map(str::to_string);
    let authed = key_ok(&sh, request_key(&headers).as_deref()) || ticket.is_some_and(|t| !t.is_empty());
    let refuse = if !has_v1 {
        Some((4400, "no supported protocol version was offered".to_string()))
    } else if !authed {
        Some((4001, "the credential is missing, expired or revoked".to_string()))
    } else {
        refuse_knob
    };
    let actor = request_actor(&headers);
    let sh2 = sh.clone();
    tokio::spawn(async move {
        if let Ok(up) = hyper::upgrade::on(req).await {
            let ws = WebSocketStream::from_raw_socket(TokioIo::new(up), Role::Server, None).await;
            run(sh2, ws, refuse, drop_after, actor).await;
        }
    });
    let mut b = Response::builder().status(101).header("upgrade", "websocket").header("connection", "Upgrade").header("sec-websocket-accept", derive_accept_key(key.as_bytes()));
    if has_v1 {
        b = b.header("sec-websocket-protocol", "opc.v1");
    }
    b.body(Full::new(Bytes::new())).unwrap()
}

struct Term {
    sid: String,
    channel: u32,
    stdin: Option<tokio::process::ChildStdin>,
    kill: Option<oneshot::Sender<()>>,
    exited: Arc<AtomicBool>,
}

/// Err: drop the connection now.
type Sent = Result<(), ()>;

struct Conn {
    sh: Arc<Shared>,
    conn: u64,
    sink: SplitSink<Ws, Message>,
    tx: mpsc::UnboundedSender<Message>,
    sent: usize,
    drop_after: Option<usize>,
    terms: HashMap<String, Term>,
    next_channel: u32,
    actor: Value,
}

impl Conn {
    async fn send(&mut self, m: Message) -> Sent {
        let (text, binary) = match &m {
            Message::Text(t) => (Some(t.as_str().to_string()), None),
            Message::Binary(b) => (None, Some(b.to_vec())),
            _ => (None, None),
        };
        self.sh.frames.lock().unwrap().push(WsFrame { conn: self.conn, dir: Dir::Out, text, binary });
        if self.sink.send(m).await.is_err() {
            return Err(());
        }
        self.sent += 1;
        if self.drop_after.is_some_and(|n| self.sent >= n) {
            return Err(());
        }
        Ok(())
    }

    async fn send_json(&mut self, v: &Value) -> Sent {
        self.send(Message::text(v.to_string())).await
    }

    async fn notify(&mut self, method: &str, params: Value) -> Sent {
        validate(&format!("notification:{method}"), &params);
        self.send_json(&json!({"jsonrpc": "2.0", "method": method, "params": params})).await
    }

    async fn result(&mut self, id: &Value, method: &str, result: Value) -> Sent {
        let m = respond(id, method, Ok(result), Instant::now());
        self.send(m).await
    }

    async fn error(&mut self, id: &Value, code: i64, message: &str, data: Option<Value>) -> Sent {
        let mut e = json!({"code": code, "message": message});
        if let Some(d) = data {
            e["data"] = d;
        }
        self.send_json(&json!({"jsonrpc": "2.0", "id": id, "error": e})).await
    }

    async fn handle_text(&mut self, text: &str) -> Sent {
        let v: Value = match serde_json::from_str(text) {
            Ok(v) => v,
            Err(e) => return self.error(&Value::Null, -32700, &format!("parse error: {e}"), None).await,
        };
        let id = v.get("id").cloned();
        let Some(method) = v["method"].as_str().map(str::to_string) else {
            return self.error(&id.unwrap_or(Value::Null), -32600, "not a JSON-RPC request", None).await;
        };
        let params = v.get("params").cloned().unwrap_or(json!({}));
        let Some(id) = id else {
            return Ok(());
        };
        let delays: Vec<Duration> = self.sh.knobs.lock().unwrap().delays.iter().filter(|(p, _)| pattern_matches(p, "ws", &method)).map(|(_, d)| *d).collect();
        for d in delays {
            tokio::time::sleep(d).await;
        }
        if let Some(f) = take_failure(&self.sh, "ws", &method) {
            let data = err_data(&f.to_err());
            return self.error(&id, -32000, &f.message, Some(data)).await;
        }
        let started = Instant::now();
        match method.as_str() {
            "ping" => self.result(&id, "ping", json!({"timing": {"serverUs": 5}})).await,
            m if m.starts_with("terminals.") => {
                let r = self.terminal(m, &params).await;
                self.send(respond(&id, &method, r, started)).await
            }
            m if API_METHODS.contains(&m) => {
                let call = match self.call_for(m, &params) {
                    Ok(c) => c,
                    Err(e) => return self.send(respond(&id, &method, Err(e), started)).await,
                };
                let long = params.get("waitMs").and_then(Value::as_u64).unwrap_or(0) > 0 || params.get("minSeq").is_some();
                if long {
                    let (sh, tx, method) = (self.sh.clone(), self.tx.clone(), method.clone());
                    tokio::spawn(async move {
                        let r = api::dispatch(&sh, call).await.map(|x| x.1);
                        let _ = tx.send(respond(&id, &method, r, started));
                    });
                    Ok(())
                } else {
                    let r = api::dispatch(&self.sh, call).await.map(|x| x.1);
                    self.send(respond(&id, &method, r, started)).await
                }
            }
            _ => self.error(&id, -32601, &format!("unknown method {method}"), None).await,
        }
    }

    fn call_for(&self, m: &str, params: &Value) -> Result<Call, ApiErr> {
        let Value::Object(p) = params else { return Err(ApiErr::bad("params", "params must be an object")) };
        let sid = p.get("sessionId").and_then(Value::as_str).ok_or_else(|| ApiErr::bad("sessionId", "sessionId is required"))?.to_string();
        let sub_key = match m {
            "turns.get" | "turns.cancel" => Some("turnId"),
            "asks.get" | "asks.answer" | "asks.dismiss" => Some("askId"),
            "subagents.get" | "subagents.stop" => Some("subagentId"),
            _ => None,
        };
        let sub = match sub_key {
            Some(k) => Some(p.get(k).and_then(Value::as_str).ok_or_else(|| ApiErr::bad(k, format!("{k} is required")))?.to_string()),
            None => None,
        };
        let write = WRITES.contains(&m);
        let mut rest = Map::new();
        for (k, v) in p {
            if k == "sessionId" || k == "idempotencyKey" || Some(k.as_str()) == sub_key {
                continue;
            }
            rest.insert(k.clone(), v.clone());
        }
        let idem = p.get("idempotencyKey").and_then(Value::as_str).map(str::to_string);
        let (query, body) = if m == "asks.answer" {
            let answer = rest.remove("answer").ok_or_else(|| ApiErr::bad("answer", "answer is required"))?;
            if let Some(k) = rest.keys().next() {
                return Err(ApiErr::bad(k, format!("unknown param {k}")));
            }
            (Map::new(), answer)
        } else if write {
            (Map::new(), if rest.is_empty() { Value::Null } else { Value::Object(rest) })
        } else {
            (rest, Value::Null)
        };
        Ok(Call { op: m.into(), sid: Some(sid), sub, query, body, idem, actor: self.actor.clone(), strict_body: true })
    }

    async fn terminal(&mut self, m: &str, p: &Value) -> Result<Value, ApiErr> {
        if m == "terminals.open" {
            return self.open_terminal(p).await;
        }
        let tid = p["terminalId"].as_str().unwrap_or("").to_string();
        let Some(t) = self.terms.get_mut(&tid).filter(|t| !t.exited.load(Ordering::SeqCst)) else {
            return Err(ApiErr::new(404, "terminal_not_found", "the terminal is not open on this connection"));
        };
        match m {
            "terminals.resize" => Ok(json!({})),
            "terminals.eof" => {
                t.stdin = None;
                Ok(json!({}))
            }
            "terminals.close" => {
                if let Some(k) = t.kill.take() {
                    let _ = k.send(());
                }
                Ok(json!({}))
            }
            _ => Err(ApiErr::new(404, "not_found", format!("no method {m}"))),
        }
    }

    async fn open_terminal(&mut self, p: &Value) -> Result<Value, ApiErr> {
        let sid = p["sessionId"].as_str().unwrap_or("").to_string();
        let owner = self.sh.read(|w| w.sess(&sid).map(|s| s.owner["id"].clone()))?;
        if owner != self.actor["id"] {
            return Err(ApiErr::new(403, "forbidden", "only the session's owner can open a terminal").with("reason", "terminal_owner_only"));
        }
        let open = self.terms.values().filter(|t| t.sid == sid && !t.exited.load(Ordering::SeqCst)).count();
        if open >= 8 {
            return Err(ApiErr::new(409, "too_many_terminals", "8 terminals are already open in this session"));
        }
        let tty = p["tty"].as_bool().unwrap_or(true);
        let command = p["command"].as_str().map(str::to_string);
        let dir = workspace::dir(&self.sh, &sid);
        let mut cmd = tokio::process::Command::new("bash");
        match &command {
            Some(c) => cmd.arg("-lc").arg(c),
            None => cmd.arg("-i"),
        };
        cmd.current_dir(&dir)
            .env("TERM", p["term"].as_str().unwrap_or("xterm-256color"))
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .kill_on_drop(true);
        let mut child = cmd.spawn().map_err(|e| ApiErr::new(500, "internal", format!("could not start bash: {e}")))?;
        let channel = self.next_channel;
        let err_channel = if tty { channel } else { channel + 1 };
        self.next_channel += if tty { 1 } else { 2 };
        let tid = new_id("tm_");
        let stdin = child.stdin.take();
        let mut readers = vec![];
        for (r, ch) in [(child.stdout.take().map(|x| Box::new(x) as Box<dyn tokio::io::AsyncRead + Unpin + Send>), channel), (child.stderr.take().map(|x| Box::new(x) as _), err_channel)] {
            let Some(mut r) = r else { continue };
            let tx = self.tx.clone();
            readers.push(tokio::spawn(async move {
                let mut buf = vec![0u8; 64 * 1024 - 4];
                loop {
                    match r.read(&mut buf).await {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut frame = ch.to_be_bytes().to_vec();
                            frame.extend_from_slice(&buf[..n]);
                            let _ = tx.send(Message::Binary(frame.into()));
                        }
                    }
                }
            }));
        }
        let (kill_tx, mut kill_rx) = oneshot::channel::<()>();
        let exited = Arc::new(AtomicBool::new(false));
        let (sh, tx, tid2, sid2, ex2) = (self.sh.clone(), self.tx.clone(), tid.clone(), sid.clone(), exited.clone());
        tokio::spawn(async move {
            let status = tokio::select! {
                s = child.wait() => s.ok(),
                _ = &mut kill_rx => {
                    let _ = child.start_kill();
                    child.wait().await.ok()
                }
            };
            for r in readers {
                let _ = r.await;
            }
            ex2.store(true, Ordering::SeqCst);
            let code = status.and_then(|s| s.code());
            #[cfg(unix)]
            let signal = status.and_then(|s| std::os::unix::process::ExitStatusExt::signal(&s)).map(|n| match n {
                1 => "SIGHUP".to_string(),
                9 => "SIGKILL".to_string(),
                15 => "SIGTERM".to_string(),
                n => format!("SIG{n}"),
            });
            #[cfg(not(unix))]
            let signal: Option<String> = None;
            let params = json!({"terminalId": tid2, "exitCode": code, "signal": signal});
            validate("notification:terminal.exited", &params);
            let _ = tx.send(Message::text(json!({"jsonrpc": "2.0", "method": "terminal.exited", "params": params}).to_string()));
            sh.with(|w| {
                if w.sess(&sid2).is_ok() {
                    w.emit(&sid2, None, "terminal.closed", None, json!({"terminalId": tid2, "exitCode": code}));
                }
            });
        });
        self.terms.insert(tid.clone(), Term { sid: sid.clone(), channel, stdin, kill: Some(kill_tx), exited });
        let actor = self.actor.clone();
        self.sh.with(|w| w.emit(&sid, None, "terminal.opened", Some(&actor), json!({"terminalId": tid, "command": command})));
        Ok(json!({"terminal": {"id": tid, "channel": channel, "stderrChannel": if tty { Value::Null } else { json!(err_channel) }}}))
    }

    async fn terminal_input(&mut self, data: &[u8]) {
        if data.len() < 4 {
            return;
        }
        let ch = u32::from_be_bytes([data[0], data[1], data[2], data[3]]);
        if let Some(t) = self.terms.values_mut().find(|t| t.channel == ch)
            && let Some(stdin) = t.stdin.as_mut()
        {
            let _ = stdin.write_all(&data[4..]).await;
            let _ = stdin.flush().await;
        }
    }
}

fn err_data(e: &ApiErr) -> Value {
    let mut d = e.body("req_ws0000000000")["error"].clone();
    d["status"] = e.status.into();
    d
}

/// A JSON-RPC response frame for a result or an API error.
fn respond(id: &Value, method: &str, r: Result<Value, ApiErr>, started: Instant) -> Message {
    let v = match r {
        Ok(mut result) => {
            if let Value::Object(m) = &mut result
                && !method.starts_with("terminals.")
                && !m.contains_key("timing")
            {
                m.insert("timing".into(), json!({"serverUs": started.elapsed().as_micros() as u64}));
            }
            validate(&format!("method:{method}"), &result);
            json!({"jsonrpc": "2.0", "id": id, "result": result})
        }
        Err(e) => {
            let data = err_data(&e);
            let code = if e.code == "invalid_request" { -32602 } else { -32000 };
            json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": e.message, "data": data}})
        }
    };
    Message::text(v.to_string())
}

async fn run(sh: Arc<Shared>, ws: Ws, refuse: Option<(u16, String)>, drop_after: Option<usize>, actor: Value) {
    let conn = {
        let mut c = sh.ws_connections.lock().unwrap();
        *c += 1;
        *c
    };
    let mut ctl = sh.ctl.subscribe();
    let (sink, mut stream) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();
    let mut c = Conn { sh: sh.clone(), conn, sink, tx, sent: 0, drop_after, terms: HashMap::new(), next_channel: 1, actor };

    if let Some((code, reason)) = refuse {
        let _ = c.sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
        let _ = c.sink.close().await;
        return;
    }
    if run_inner(&mut c, &mut stream, &mut rx, &mut ctl).await.is_err() {
        // Dropped without a close frame: the socket just goes away.
    }
}

async fn run_inner(
    c: &mut Conn,
    stream: &mut futures_util::stream::SplitStream<Ws>,
    rx: &mut mpsc::UnboundedReceiver<Message>,
    ctl: &mut tokio::sync::broadcast::Receiver<(u16, String)>,
) -> Sent {
    c.notify(
        "ready",
        json!({
            "connectionId": new_id("wc_"), "server": {"version": "fake-2026-10-26", "region": "fra"}, "protocol": {"features": []},
            "limits": {"maxAttached": 20, "maxMessageBytes": 1048576, "maxRequestsPerSecond": 100}, "expiresAt": null, "expiresInMs": null,
        }),
    )
    .await?;

    loop {
        tokio::select! {
            biased;
            m = rx.recv() => {
                if let Some(m) = m {
                    c.send(m).await?;
                }
            }
            m = stream.next() => match m {
                Some(Ok(Message::Text(t))) => {
                    c.sh.frames.lock().unwrap().push(WsFrame { conn: c.conn, dir: Dir::In, text: Some(t.as_str().to_string()), binary: None });
                    c.handle_text(t.as_str()).await?;
                }
                Some(Ok(Message::Binary(b))) => {
                    c.sh.frames.lock().unwrap().push(WsFrame { conn: c.conn, dir: Dir::In, text: None, binary: Some(b.to_vec()) });
                    c.terminal_input(&b).await;
                }
                Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                    let _ = c.sink.close().await;
                    return Ok(());
                }
                Some(Ok(_)) => {
                    // Pings are answered by tungstenite on the next write; flush so it goes now.
                    let _ = c.sink.flush().await;
                }
            },
            k = ctl.recv() => {
                if let Ok((code, reason)) = k {
                    if code == 0 {
                        return Err(());
                    }
                    let _ = c.sink.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                    let _ = c.sink.close().await;
                    return Ok(());
                }
            }
        }
    }
}
