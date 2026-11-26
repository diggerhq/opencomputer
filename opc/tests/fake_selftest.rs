//! Tests of the fake Computer itself, over real HTTP and WebSocket, without opc.

mod support;

use std::io::{Read, Write};
use std::net::TcpStream;
use std::time::Duration;

use futures_util::{SinkExt, StreamExt};
use serde_json::{Value, json};
use support::{Call, Failure, Fake, Seed, TEST_KEY};
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::Message;

const T: Duration = Duration::from_secs(10);

struct Resp {
    status: u16,
    headers: Vec<(String, String)>,
    body: Value,
}

impl Resp {
    fn header(&self, name: &str) -> Option<&str> {
        self.headers.iter().find(|(k, _)| k.eq_ignore_ascii_case(name)).map(|(_, v)| v.as_str())
    }
}

/// A minimal HTTP/1.1 client: one request per connection.
fn http(fake: &Fake, method: &str, path: &str, body: Option<Value>, idem: Option<&str>) -> Resp {
    let addr = fake.url.trim_start_matches("http://");
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(T)).unwrap();
    let body = body.map(|b| b.to_string()).unwrap_or_default();
    let mut req = format!(
        "{method} {}{path} HTTP/1.1\r\nHost: {addr}\r\nAuthorization: Bearer {TEST_KEY}\r\nUser-Agent: selftest/1\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n",
        support::API_PREFIX,
        body.len()
    );
    if let Some(k) = idem {
        req.push_str(&format!("Idempotency-Key: {k}\r\n"));
    }
    req.push_str("\r\n");
    req.push_str(&body);
    s.write_all(req.as_bytes()).unwrap();
    let mut raw = vec![];
    s.read_to_end(&mut raw).unwrap();
    let split = raw.windows(4).position(|w| w == b"\r\n\r\n").expect("no header end");
    let head = String::from_utf8_lossy(&raw[..split]).to_string();
    let mut lines = head.split("\r\n");
    let status: u16 = lines.next().unwrap().split(' ').nth(1).unwrap().parse().unwrap();
    let headers: Vec<(String, String)> = lines.filter_map(|l| l.split_once(':')).map(|(k, v)| (k.trim().to_lowercase(), v.trim().to_string())).collect();
    let rest = &raw[split + 4..];
    let chunked = headers.iter().any(|(k, v)| k == "transfer-encoding" && v.contains("chunked"));
    let bytes = if chunked { dechunk(rest) } else { rest.to_vec() };
    let body = if bytes.is_empty() { Value::Null } else { serde_json::from_slice(&bytes).unwrap_or_else(|e| panic!("bad JSON ({e}): {}", String::from_utf8_lossy(&bytes))) };
    Resp { status, headers, body }
}

fn dechunk(mut b: &[u8]) -> Vec<u8> {
    let mut out = vec![];
    loop {
        let nl = b.windows(2).position(|w| w == b"\r\n").unwrap();
        let n = usize::from_str_radix(std::str::from_utf8(&b[..nl]).unwrap().trim(), 16).unwrap();
        if n == 0 {
            return out;
        }
        out.extend_from_slice(&b[nl + 2..nl + 2 + n]);
        b = &b[nl + 4 + n..];
    }
}

fn types(events: &[Value]) -> Vec<String> {
    events.iter().map(|e| e["type"].as_str().unwrap().to_string()).collect()
}

fn completed_text(fake: &Fake, sid: &str, tid: &str) -> Value {
    fake.events_of(sid, "turn.completed").into_iter().find(|e| e["turnId"] == tid).unwrap_or_else(|| panic!("{tid} did not complete: {:#?}", fake.turn(sid, tid)))["data"]["text"].clone()
}

#[test]
fn create_turn_events_over_http() {
    let fake = Fake::start();
    let r = http(&fake, "POST", "/sessions", Some(json!({"input": "reply hello world"})), Some("k-create-1"));
    assert_eq!(r.status, 201, "{}", r.body);
    assert!(r.header("server-timing").unwrap().starts_with("total;dur="));
    assert!(r.header("x-request-id").is_some());
    let sid = r.body["session"]["id"].as_str().unwrap().to_string();
    let tid = r.body["turn"]["id"].as_str().unwrap().to_string();
    assert_eq!(r.body["delivery"], "started");
    assert!(fake.wait_turn(&sid, &tid, T));
    assert_eq!(completed_text(&fake, &sid, &tid), "hello world");

    let ev = http(&fake, "GET", &format!("/sessions/{sid}/events"), None, None);
    assert_eq!(ev.status, 200);
    let ts = types(ev.body["events"].as_array().unwrap());
    for t in ["session.created", "message.received", "turn.started", "message.completed", "turn.completed"] {
        assert!(ts.contains(&t.to_string()), "{t} missing from {ts:?}");
    }
    assert_eq!(ev.body["lastSeq"], ts.len() as u64);
    let cursor = ev.body["cursor"].as_str().unwrap().to_string();
    let mr = &fake.events_of(&sid, "message.received")[0];
    assert_eq!(mr["data"]["declinedAskIds"], json!([]));

    // Long poll from the cursor: waits for the next turn's events.
    let (t2, _) = fake.send(&sid, "slow 150", "queue").unwrap();
    let lp = http(&fake, "GET", &format!("/sessions/{sid}/events?after={cursor}&waitMs=5000"), None, None);
    assert!(!lp.body["events"].as_array().unwrap().is_empty());
    assert!(lp.body["cursor"].is_string());
    assert!(fake.wait_turn(&sid, &t2, T));
    assert_eq!(fake.requests_to("GET /sessions/*/events").len(), 2);

    // A bare integer is not a cursor: `reset` with none to go on from.
    let r = http(&fake, "GET", &format!("/sessions/{sid}/events?after=0"), None, None);
    assert_eq!(r.status, 409);
    assert_eq!(r.body["error"]["code"], "reset");
    assert!(r.body["error"]["cursor"].is_null());
    // A rewritten tail voids the cursor: `reset` with the seq to keep and the cursor for it.
    fake.rewrite_above(&sid, 2);
    let r = http(&fake, "GET", &format!("/sessions/{sid}/events?after={cursor}"), None, None);
    assert_eq!((r.status, &r.body["error"]["code"], &r.body["error"]["seq"]), (409, &json!("reset"), &json!(2)), "{}", r.body);
    let again = r.body["error"]["cursor"].as_str().unwrap();
    assert_ne!(again, cursor);
    let r = http(&fake, "GET", &format!("/sessions/{sid}/events?after={again}"), None, None);
    assert_eq!(r.status, 200, "{}", r.body);
    fake.assert_no_panics();
}

#[test]
fn idempotent_repeat_and_conflict() {
    let fake = Fake::start();
    let body = json!({"input": "reply once"});
    let a = http(&fake, "POST", "/sessions", Some(body.clone()), Some("k-same"));
    let b = http(&fake, "POST", "/sessions", Some(body), Some("k-same"));
    assert_eq!(a.status, 201);
    assert_eq!(b.status, 200, "{}", b.body);
    assert_eq!(b.body["duplicate"], true);
    assert_eq!(a.body["session"]["id"], b.body["session"]["id"]);
    assert_eq!(fake.session_ids().len(), 1);

    let c = http(&fake, "POST", "/sessions", Some(json!({"input": "something else"})), Some("k-same"));
    assert_eq!(c.status, 409);
    assert_eq!(c.body["error"]["code"], "idempotency_conflict", "{}", c.body);

    let sid = a.body["session"]["id"].as_str().unwrap();
    let s1 = http(&fake, "POST", &format!("/sessions/{sid}/turns"), Some(json!({"input": "reply two"})), Some("k-turn"));
    let s2 = http(&fake, "POST", &format!("/sessions/{sid}/turns"), Some(json!({"input": "reply two"})), Some("k-turn"));
    assert_eq!(s1.body["turn"]["id"], s2.body["turn"]["id"]);
    assert_eq!(s2.body["duplicate"], true);
    assert!(fake.wait_idle(sid, T));
    assert_eq!(fake.turns(sid).len(), 2);
    fake.assert_no_panics();
}

#[test]
fn ask_round_trips() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("asks"));

    // A question answered over HTTP.
    let (tid, _) = fake.send(&sid, "question", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).expect("no ask");
    let aid = ask["id"].as_str().unwrap();
    let bad = http(&fake, "POST", &format!("/sessions/{sid}/asks/{aid}/answer"), Some(json!({"answers": [{"questionId": "q1", "choices": ["green"]}]})), Some("a0"));
    assert_eq!(bad.status, 400);
    assert_eq!(bad.body["error"]["code"], "invalid_answer");
    let ok = http(&fake, "POST", &format!("/sessions/{sid}/asks/{aid}/answer"), Some(json!({"answers": [{"questionId": "q1", "choices": ["red"]}]})), Some("a1"));
    assert_eq!(ok.status, 200, "{}", ok.body);
    assert!(fake.wait_turn(&sid, &tid, T));
    assert_eq!(completed_text(&fake, &sid, &tid), "answer: red");

    // mode is for plan approvals only.
    let (tid, _) = fake.send(&sid, "approve", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).unwrap();
    let e = fake.answer(&sid, ask["id"].as_str().unwrap(), json!({"decision": "allow", "mode": "acceptEdits"})).unwrap_err();
    assert_eq!((e.status, e.code.as_str()), (400, "invalid_answer"));
    fake.answer(&sid, ask["id"].as_str().unwrap(), json!({"decision": "allow"})).unwrap();
    assert!(fake.wait_turn(&sid, &tid, T));
    assert_eq!(completed_text(&fake, &sid, &tid), "approval: allow");

    // Allowing a plan with a mode switches the session to it.
    fake.call(Call { op: "sessions.update".into(), sid: Some(sid.clone()), body: json!({"mode": "plan"}), ..Default::default() }).unwrap();
    let (tid, _) = fake.send(&sid, "plan", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).unwrap();
    assert_eq!(ask["approval"]["toolName"], "ExitPlanMode");
    fake.answer(&sid, ask["id"].as_str().unwrap(), json!({"decision": "allow", "mode": "acceptEdits"})).unwrap();
    assert!(fake.wait_turn(&sid, &tid, T));
    assert_eq!(fake.session(&sid)["settings"]["mode"], "acceptEdits");

    // A steer while an ask is open declines it.
    let (tid, _) = fake.send(&sid, "approve", "queue").unwrap();
    let ask = fake.wait_ask(&sid, T).unwrap();
    let aid = ask["id"].as_str().unwrap().to_string();
    let (steer_tid, delivery) = fake.send(&sid, "never mind", "steer").unwrap();
    assert_eq!(delivery, "steered");
    assert_eq!(steer_tid, tid);
    let closed = fake.asks(&sid).into_iter().find(|a| a["id"] == aid.as_str()).unwrap();
    assert_eq!(closed["status"], "declined");
    assert_eq!(closed["answer"]["message"], "never mind");
    let mr = fake.events_of(&sid, "message.received").pop().unwrap();
    assert_eq!(mr["data"]["declinedAskIds"], json!([aid]));
    assert_eq!(closed["answer"]["messageSeq"], mr["seq"]);
    assert!(fake.wait_idle(&sid, T));
    assert!(fake.events_of(&sid, "turn.steered").iter().any(|e| e["turnId"] == tid.as_str()));
    assert!(completed_text(&fake, &sid, &tid).as_str().unwrap().starts_with("approval: declined"));
    fake.assert_no_panics();
}

#[test]
fn background_subagent_starts_its_own_turn() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("bg"));
    let (tid, _) = fake.send(&sid, "subagent bg 200", "queue").unwrap();
    assert!(fake.wait_turn(&sid, &tid, T));
    let s2 = sid.clone();
    assert!(fake.wait_for(T, move |w| w.sess(&s2).is_ok_and(|s| s.turns.iter().any(|t| t["trigger"] == "subagent" && t["status"] == "completed"))));
    let own = fake.turns(&sid).into_iter().find(|t| t["trigger"] == "subagent").unwrap();
    assert!(own["input"].is_null());
    assert_eq!(fake.events_of(&sid, "subagent.started").len(), 1);
    assert_eq!(fake.events_of(&sid, "subagent.ended").len(), 1);
    fake.assert_no_panics();
}

#[test]
fn interrupt_cancels_the_turn() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("int"));
    let (tid, _) = fake.send(&sid, "slow 5000", "queue").unwrap();
    fake.wait_event(&sid, "turn.started", T).unwrap();
    let (queued, d) = fake.send(&sid, "reply later", "queue").unwrap();
    assert_eq!(d, "queued");
    let r = http(&fake, "POST", &format!("/sessions/{sid}/interrupt"), Some(json!({})), Some("i1"));
    assert_eq!(r.status, 202, "{}", r.body);
    assert_eq!(r.body["session"]["status"], "running");
    // Queued turns are cancelled before the response; the running one stops shortly after.
    assert_eq!(fake.turn(&sid, &queued)["status"], "cancelled");
    assert!(fake.wait_turn(&sid, &tid, T));
    let c = fake.events_of(&sid, "turn.cancelled").into_iter().find(|e| e["turnId"] == tid.as_str()).unwrap();
    assert_eq!(c["data"]["reason"], "interrupted");
    // Nothing running: 200, nothing changes.
    let r = http(&fake, "POST", &format!("/sessions/{sid}/interrupt"), Some(json!({})), Some("i2"));
    assert_eq!(r.status, 200, "{}", r.body);
    fake.assert_no_panics();
}

#[test]
fn injected_failures_and_auth() {
    let fake = Fake::start();
    fake.fail_next("GET /me", 1, Failure::rate_limited(250));
    let r = http(&fake, "GET", "/me", None, None);
    assert_eq!(r.status, 429);
    assert_eq!(r.body["error"]["code"], "rate_limited");
    let r = http(&fake, "GET", "/me", None, None);
    assert_eq!(r.status, 200);
    assert_eq!(r.body["computer"]["status"], "ready");
    fake.revoke_key();
    assert_eq!(http(&fake, "GET", "/me", None, None).status, 401);
    fake.assert_no_panics();
}

#[test]
fn schema_check_catches_a_bad_object() {
    let good = json!({"id": "cs_0123456789abcdef"});
    assert!(support::check("SessionId", &good["id"]).is_ok());
    let err = support::check("Turn", &json!({"id": 5})).unwrap_err();
    assert!(err.contains("schema violation against Turn"), "{err}");
    let err = support::check("Event", &json!({"type": "turn.completed", "seq": "one"})).unwrap_err();
    assert!(err.contains("Event.turn.completed"), "{err}");
    // New delta types pass on their envelope.
    let d = json!({"type": "tool.preparing", "sessionId": "cs_0123456789abcdef", "turnId": "tn_0123456789ab", "data": {"callId": "c", "toolName": "Bash", "subagentId": null, "path": null, "description": null, "lines": null}});
    assert!(support::check("Delta", &d).is_ok());
    assert!(support::check("Delta", &json!({"type": "tool.preparing"})).is_err());
}

type Ws = tokio_tungstenite::WebSocketStream<tokio_tungstenite::MaybeTlsStream<tokio::net::TcpStream>>;

async fn ws_connect(fake: &Fake, query: &str, protocol: &str) -> Ws {
    let mut req = format!("{}{query}", fake.wire_url).into_client_request().unwrap();
    req.headers_mut().insert("authorization", format!("Bearer {TEST_KEY}").parse().unwrap());
    req.headers_mut().insert("sec-websocket-protocol", protocol.parse().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws
}

/// Next JSON frame, or None when the connection ended.
async fn next(ws: &mut Ws) -> Option<Value> {
    loop {
        match tokio::time::timeout(T, ws.next()).await.expect("timed out waiting for a frame") {
            Some(Ok(Message::Text(t))) => return Some(serde_json::from_str(&t).unwrap()),
            Some(Ok(Message::Close(_))) | None | Some(Err(_)) => return None,
            Some(Ok(_)) => {}
        }
    }
}

async fn until(ws: &mut Ws, mut f: impl FnMut(&Value) -> bool) -> Value {
    loop {
        let v = next(ws).await.expect("connection ended");
        if f(&v) {
            return v;
        }
    }
}

/// The live socket, with the key as the second subprotocol.
async fn live_connect(fake: &Fake) -> Ws {
    let mut req = format!("{}/live", fake.url.replacen("http", "ws", 1)).into_client_request().unwrap();
    req.headers_mut().insert("sec-websocket-protocol", format!("oc.live.v1, oc.bearer.{TEST_KEY}").parse().unwrap());
    let (ws, _) = tokio_tungstenite::connect_async(req).await.unwrap();
    ws
}

async fn say(ws: &mut Ws, v: Value) {
    ws.send(Message::text(v.to_string())).await.unwrap();
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_calls_and_errors() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("ws").turn("reply first"));
    let mut ws = ws_connect(&fake, "", "opc.v1").await;
    assert_eq!(next(&mut ws).await.unwrap()["method"], "ready");
    say(&mut ws, json!({"jsonrpc": "2.0", "id": 1, "method": "turns.send", "params": {"sessionId": sid, "input": "tool", "ifBusy": "queue"}})).await;
    let res = until(&mut ws, |v| v["id"] == 1).await;
    assert_eq!(res["result"]["delivery"], "started", "{res}");
    // An error is -32000 with the HTTP error in data.
    say(&mut ws, json!({"jsonrpc": "2.0", "id": 2, "method": "turns.get", "params": {"sessionId": sid, "turnId": "tu_nope"}})).await;
    let e = until(&mut ws, |v| v["id"] == 2).await;
    assert_eq!(e["error"]["code"], -32000);
    assert_eq!(e["error"]["data"]["status"], 404);
    // Watching a session has left this socket.
    say(&mut ws, json!({"jsonrpc": "2.0", "id": 3, "method": "sessions.attach", "params": {"sessionId": sid}})).await;
    assert!(until(&mut ws, |v| v["id"] == 3).await["error"].is_object());
    // Dropped without a close frame: the stream just ends.
    fake.drop_ws_now(None);
    while next(&mut ws).await.is_some() {}
    assert!(fake.ws_calls().iter().any(|(m, _)| m == "turns.send"));
    fake.assert_no_panics();
}

#[tokio::test(flavor = "multi_thread")]
async fn live_socket_pushes_ranges_deltas_blocks_and_reset() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("live").turn("reply first"));
    let page = http(&fake, "GET", &format!("/sessions/{sid}/events"), None, None).body;
    let (cursor, held) = (page["cursor"].as_str().unwrap().to_string(), page["lastSeq"].as_u64().unwrap());
    let (events, deltas) = (format!("events:{sid}"), format!("deltas:{sid}"));

    let mut ws = live_connect(&fake).await;
    say(&mut ws, json!({"t": "hello", "protocol": 1, "clientId": "cl_0123456789abcdef"})).await;
    say(&mut ws, json!({"t": "sub", "stream": events, "after": cursor})).await;
    say(&mut ws, json!({"t": "sub", "stream": deltas})).await;
    assert_eq!(until(&mut ws, |v| v["t"] == "ready").await["protocol"], 1);
    // Nothing new: the head is the cursor held.
    assert_eq!(until(&mut ws, |v| v["t"] == "subd" && v["stream"] == events.as_str()).await["head"], cursor.as_str());

    // Pushed ranges chain by cursor; deltas carry the block's length before them in UTF-16 code units.
    let (t2, _) = fake.send(&sid, "reply caf\u{e9} \u{1F600} and on", "queue").unwrap();
    let (mut at, mut seqs, mut text, mut block) = (cursor.clone(), vec![], String::new(), String::new());
    loop {
        let v = next(&mut ws).await.unwrap();
        if v["t"] == "events" {
            assert_eq!(v["from"], at.as_str(), "a range must start at the last one's end");
            at = v["to"].as_str().unwrap().to_string();
            seqs.extend(v["events"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()));
            if v["events"].as_array().unwrap().iter().any(|e| e["type"] == "turn.completed") {
                break;
            }
        } else if v["t"] == "delta" && v["type"] == "message.delta" {
            assert_eq!(v["offset"].as_u64().unwrap(), text.encode_utf16().count() as u64, "offset after {text:?}");
            assert!(v["whole"].is_null());
            text.push_str(v["data"]["text"].as_str().unwrap());
            block = v["data"]["blockId"].as_str().unwrap().to_string();
        }
    }
    assert!(fake.wait_turn(&sid, &t2, T));
    let last = fake.events(&sid).len() as u64;
    while seqs.last() != Some(&last) {
        let v = until(&mut ws, |v| v["t"] == "events").await;
        assert_eq!(v["from"], at.as_str());
        at = v["to"].as_str().unwrap().to_string();
        seqs.extend(v["events"].as_array().unwrap().iter().map(|e| e["seq"].as_u64().unwrap()));
    }
    assert_eq!(seqs, (held + 1..=last).collect::<Vec<u64>>(), "gap or duplicate");
    assert!(text.contains('\u{1F600}') && text.encode_utf16().count() != text.chars().count(), "{text:?}");

    // `block`: the block so far, as one delta at offset 0 marked `whole`.
    say(&mut ws, json!({"t": "block", "session": sid, "blockId": block})).await;
    let whole = until(&mut ws, |v| v["t"] == "delta").await;
    assert_eq!((&whole["offset"], &whole["whole"], whole["data"]["text"].as_str()), (&json!(0), &json!(true), Some(text.as_str())));

    // A rewritten tail: `behind` to those subscribed, and `reset` to a `sub` from a void cursor.
    fake.rewrite_above(&sid, held);
    let behind = until(&mut ws, |v| v["t"] == "behind").await;
    assert_ne!(behind["head"], at.as_str());
    say(&mut ws, json!({"t": "sub", "stream": events, "after": at})).await;
    let reset = until(&mut ws, |v| v["t"] == "reset").await;
    assert_eq!((&reset["stream"], &reset["seq"], &reset["cursor"]), (&json!(events), &json!(held), &behind["head"]), "{reset}");
    // Not a cursor at all: `reset` with none.
    say(&mut ws, json!({"t": "sub", "stream": events, "after": "7"})).await;
    assert!(until(&mut ws, |v| v["t"] == "reset").await["cursor"].is_null());
    assert_eq!(fake.live_connections(), 1);
    fake.assert_no_panics();
}

/// A raw upgrade (tungstenite's client refuses a 101 without the subprotocol it
/// offered), then the first frame the server sends: its close code.
fn raw_upgrade_close_code(fake: &Fake, protocol: Option<&str>, auth: bool) -> u16 {
    let addr = fake.url.trim_start_matches("http://");
    let mut s = TcpStream::connect(addr).unwrap();
    s.set_read_timeout(Some(T)).unwrap();
    let mut req = format!("GET /v1 HTTP/1.1\r\nHost: {addr}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Version: 13\r\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\r\n");
    if let Some(p) = protocol {
        req.push_str(&format!("Sec-WebSocket-Protocol: {p}\r\n"));
    }
    if auth {
        req.push_str(&format!("Authorization: Bearer {TEST_KEY}\r\n"));
    }
    req.push_str("\r\n");
    s.write_all(req.as_bytes()).unwrap();
    let mut buf = vec![];
    let mut b = [0u8; 1];
    while !buf.ends_with(b"\r\n\r\n") {
        s.read_exact(&mut b).unwrap();
        buf.push(b[0]);
    }
    assert!(buf.starts_with(b"HTTP/1.1 101"), "{}", String::from_utf8_lossy(&buf));
    let mut head = [0u8; 4];
    s.read_exact(&mut head).unwrap();
    assert_eq!(head[0], 0x88, "expected a close frame");
    u16::from_be_bytes([head[2], head[3]])
}

#[test]
fn websocket_refusals() {
    let fake = Fake::start();
    assert_eq!(raw_upgrade_close_code(&fake, None, true), 4400);
    assert_eq!(raw_upgrade_close_code(&fake, Some("opc.v0"), true), 4400);
    assert_eq!(raw_upgrade_close_code(&fake, Some("opc.v1"), false), 4001);
    fake.refuse_ws(Some((4503, r#"{"retryAfterMs":500}"#)));
    assert_eq!(raw_upgrade_close_code(&fake, Some("opc.v1"), true), 4503);
}

#[test]
fn opc_command_points_at_the_fake() {
    let fake = Fake::start();
    let env = fake.env();
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.clone()).unwrap();
    assert_eq!(get("OPENCOMPUTER_API_URL"), fake.url);
    assert_eq!(get("OPC_WIRE_URL"), fake.wire_url);
    assert_eq!(get("OPENCOMPUTER_API_KEY"), TEST_KEY);
}

#[tokio::test(flavor = "multi_thread")]
async fn websocket_terminal_echoes_stdin() {
    let fake = Fake::start();
    let sid = fake.seed_session(Seed::new("term"));
    let mut ws = ws_connect(&fake, "", "opc.v1").await;
    until(&mut ws, |v| v["method"] == "ready").await;
    ws.send(Message::text(json!({"jsonrpc": "2.0", "id": 1, "method": "terminals.open", "params": {"sessionId": sid, "command": "cat", "tty": false}}).to_string())).await.unwrap();
    let r = until(&mut ws, |v| v["id"] == 1).await;
    let ch = r["result"]["terminal"]["channel"].as_u64().unwrap_or_else(|| panic!("{r}")) as u32;
    let mut frame = ch.to_be_bytes().to_vec();
    frame.extend_from_slice(b"ping\n");
    ws.send(Message::Binary(frame.into())).await.unwrap();
    loop {
        match tokio::time::timeout(T, ws.next()).await.unwrap() {
            Some(Ok(Message::Binary(b))) => {
                assert_eq!(&b[..4], &ch.to_be_bytes());
                assert_eq!(&b[4..], b"ping\n");
                break;
            }
            Some(Ok(_)) => {}
            other => panic!("no terminal output: {other:?}"),
        }
    }
    let term = r["result"]["terminal"]["id"].as_str().unwrap();
    ws.send(Message::text(json!({"jsonrpc": "2.0", "id": 2, "method": "terminals.eof", "params": {"terminalId": term}}).to_string())).await.unwrap();
    let exited = until(&mut ws, |v| v["method"] == "terminal.exited").await;
    assert_eq!(exited["params"]["exitCode"], 0, "{exited}");
}
