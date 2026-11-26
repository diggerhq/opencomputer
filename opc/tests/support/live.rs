//! The live socket, `GET /live` (`oc.live.v1`): `hello` and `ready`, `sub`
//! on `events:<id>` and `deltas:<id>`, pushed ranges of events with their
//! cursors, deltas with their offsets, `block`, `reset`, and the drop knob.
//! The token is the second subprotocol, `oc.bearer.<key>`.

use super::http::{Resp, key_ok};
use super::model::{Out, Shared, new_id};
use super::{Dir, WsFrame};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use http_body_util::Full;
use hyper::body::Incoming;
use hyper::upgrade::Upgraded;
use hyper::{Request, Response};
use hyper_util::rt::TokioIo;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::Arc;
use tokio_tungstenite::WebSocketStream;
use tokio_tungstenite::tungstenite::Message;
use tokio_tungstenite::tungstenite::handshake::derive_accept_key;
use tokio_tungstenite::tungstenite::protocol::frame::coding::CloseCode;
use tokio_tungstenite::tungstenite::protocol::{CloseFrame, Role};

type Ws = WebSocketStream<TokioIo<Upgraded>>;
/// Err: drop the connection now.
type Sent = Result<(), ()>;

pub async fn upgrade(sh: Arc<Shared>, req: Request<Incoming>, headers: Vec<(String, String)>) -> Resp {
    let (enabled, refuse_knob, drop_after) = {
        let mut k = sh.knobs.lock().unwrap();
        (k.ws_enabled, k.ws_refuse.clone(), k.live_drop_after.take())
    };
    let json = |status: u16, body: &str| Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(body.to_string()))).unwrap();
    if !enabled {
        return json(404, r#"{"error":{"code":"not_found","message":"no WebSocket here","retryable":false}}"#);
    }
    let get = |n: &str| headers.iter().find(|(k, _)| k == n).map(|(_, v)| v.clone());
    let Some(key) = get("sec-websocket-key") else {
        return json(400, r#"{"error":{"code":"invalid_request","message":"not a WebSocket upgrade","retryable":false}}"#);
    };
    let protos: Vec<String> = get("sec-websocket-protocol").map(|p| p.split(',').map(|s| s.trim().to_string()).collect()).unwrap_or_default();
    let has_v1 = protos.iter().any(|p| p == "oc.live.v1");
    let token = protos.iter().find_map(|p| p.strip_prefix("oc.bearer.")).map(str::to_string);
    let refuse = if !has_v1 {
        Some((4400, "no supported protocol version was offered".to_string()))
    } else if !key_ok(&sh, token.as_deref()) {
        Some((4001, "the credential is missing, expired or revoked".to_string()))
    } else {
        refuse_knob
    };
    let sh2 = sh.clone();
    tokio::spawn(async move {
        if let Ok(up) = hyper::upgrade::on(req).await {
            let mut ws = WebSocketStream::from_raw_socket(TokioIo::new(up), Role::Server, None).await;
            if let Some((code, reason)) = refuse {
                let _ = ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                let _ = ws.close(None).await;
                return;
            }
            let conn = {
                let mut c = sh2.live_connections.lock().unwrap();
                *c += 1;
                *c
            };
            let mut c = Conn { sh: sh2, conn, ws, events: HashSet::new(), deltas: HashSet::new(), sent: 0, drop_after };
            let _ = c.run().await;
        }
    });
    let mut b = Response::builder().status(101).header("upgrade", "websocket").header("connection", "Upgrade").header("sec-websocket-accept", derive_accept_key(key.as_bytes()));
    if has_v1 {
        b = b.header("sec-websocket-protocol", "oc.live.v1");
    }
    b.body(Full::new(Bytes::new())).unwrap()
}

struct Conn {
    sh: Arc<Shared>,
    conn: u64,
    ws: Ws,
    /// Sessions whose events and deltas this socket is subscribed to.
    events: HashSet<String>,
    deltas: HashSet<String>,
    sent: usize,
    drop_after: Option<usize>,
}

fn session_of<'a>(stream: &'a str, kind: &str) -> Option<&'a str> {
    stream.strip_prefix(kind).and_then(|s| s.strip_prefix(':'))
}

impl Conn {
    async fn send(&mut self, v: Value) -> Sent {
        let text = v.to_string();
        self.sh.live_frames.lock().unwrap().push(WsFrame { conn: self.conn, dir: Dir::Out, text: Some(text.clone()), binary: None });
        if self.ws.send(Message::text(text)).await.is_err() {
            return Err(());
        }
        self.sent += 1;
        if self.drop_after.is_some_and(|n| self.sent >= n) {
            return Err(());
        }
        Ok(())
    }

    async fn run(&mut self) -> Sent {
        // Subscribe before reading any state, so nothing falls between a head and a push.
        let mut bus = self.sh.bus.subscribe();
        let mut ctl = self.sh.ctl.subscribe();
        loop {
            tokio::select! {
                biased;
                m = self.ws.next() => match m {
                    Some(Ok(Message::Text(t))) => {
                        self.sh.live_frames.lock().unwrap().push(WsFrame { conn: self.conn, dir: Dir::In, text: Some(t.as_str().to_string()), binary: None });
                        self.on_frame(t.as_str()).await?;
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => {
                        let _ = self.ws.close(None).await;
                        return Ok(());
                    }
                    Some(Ok(_)) => {
                        let _ = self.ws.flush().await;
                    }
                },
                out = bus.recv() => match out {
                    Ok(out) => self.forward(out).await?,
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => {}
                    Err(_) => return Ok(()),
                },
                k = ctl.recv() => {
                    if let Ok((code, reason)) = k {
                        if code == 0 {
                            return Err(());
                        }
                        let _ = self.ws.send(Message::Close(Some(CloseFrame { code: CloseCode::from(code), reason: reason.into() }))).await;
                        let _ = self.ws.close(None).await;
                        return Ok(());
                    }
                }
            }
        }
    }

    async fn on_frame(&mut self, text: &str) -> Sent {
        let Ok(v) = serde_json::from_str::<Value>(text) else {
            return self.send(json!({"t": "error", "code": "invalid_request", "message": "not JSON"})).await;
        };
        let stream = v["stream"].as_str().unwrap_or("").to_string();
        match v["t"].as_str().unwrap_or("") {
            "hello" => {
                let ready = json!({
                    "t": "ready", "connectionId": new_id("lc_"), "protocol": 1, "org": "org_fake", "subject": "usr_fake", "expiresAt": null,
                    "limits": {"maxWatched": 32},
                });
                self.send(ready).await
            }
            "ping" => self.send(json!({"t": "pong"})).await,
            "sub" => {
                if let Some(sid) = session_of(&stream, "events") {
                    // The head, or how a void cursor is answered.
                    let head = self.sh.read(|w| w.sess(sid).ok().map(|s| (s.cursor(), v["after"].as_str().map(|a| s.seq_of(a)))));
                    match head {
                        None => self.send(json!({"t": "detached", "stream": stream, "reason": "gone"})).await,
                        Some((_, Some(Err((cursor, seq))))) => self.send(json!({"t": "reset", "stream": stream, "cursor": cursor, "seq": seq})).await,
                        Some((head, _)) => {
                            self.events.insert(sid.to_string());
                            self.send(json!({"t": "subd", "stream": stream, "head": head})).await
                        }
                    }
                } else if let Some(sid) = session_of(&stream, "deltas") {
                    if self.sh.read(|w| w.sess(sid).is_ok()) {
                        self.deltas.insert(sid.to_string());
                        self.sh.with(|w| w.delta_watched.insert(sid.to_string()));
                        self.send(json!({"t": "subd", "stream": stream, "head": null})).await
                    } else {
                        self.send(json!({"t": "detached", "stream": stream, "reason": "gone"})).await
                    }
                } else {
                    self.send(json!({"t": "error", "code": "invalid_request", "message": format!("unknown stream {stream}")})).await
                }
            }
            "unsub" => {
                if let Some(sid) = session_of(&stream, "events") {
                    self.events.remove(sid);
                } else if let Some(sid) = session_of(&stream, "deltas") {
                    self.deltas.remove(sid);
                }
                Ok(())
            }
            "block" => {
                // The block so far, as one delta at offset 0 marked `whole`.
                let (sid, block) = (v["session"].as_str().unwrap_or(""), v["blockId"].as_str().unwrap_or(""));
                let held = self.sh.read(|w| w.sess(sid).ok().and_then(|s| s.blocks.get(block).cloned()));
                match held {
                    Some((ty, turn, text)) => self.send(json!({"t": "delta", "session": sid, "type": ty, "turnId": turn, "data": {"blockId": block, "text": text}, "offset": 0, "whole": true})).await,
                    None => Ok(()),
                }
            }
            other => self.send(json!({"t": "error", "code": "invalid_request", "message": format!("unknown frame {other}")})).await,
        }
    }

    async fn forward(&mut self, out: Out) -> Sent {
        match out {
            Out::Event(sid, ev) => {
                if !self.events.contains(&sid) {
                    return Ok(());
                }
                let seq = ev["seq"].as_u64().unwrap_or(0);
                // The cursors before and after this event, in the log as it is now.
                let Some((from, to)) = self.sh.read(|w| w.sess(&sid).ok().map(|s| (s.cursor_at(seq.saturating_sub(1)), s.cursor_at(seq)))) else { return Ok(()) };
                self.send(json!({"t": "events", "session": sid, "from": from, "to": to, "events": [*ev]})).await
            }
            Out::Delta(sid, d, offset) => {
                if !self.deltas.contains(&sid) {
                    return Ok(());
                }
                self.send(json!({"t": "delta", "session": sid, "type": d["type"], "turnId": d["turnId"], "data": d["data"], "offset": offset.unwrap_or(0)})).await
            }
            Out::Reset(sid) => {
                if !self.events.contains(&sid) {
                    return Ok(());
                }
                let Some(head) = self.sh.read(|w| w.sess(&sid).ok().map(|s| s.cursor())) else { return Ok(()) };
                self.send(json!({"t": "behind", "stream": format!("events:{sid}"), "head": head})).await
            }
        }
    }
}
