//! The HTTP side: routing, auth, logging, injected failures and delays,
//! device login at the host root, and the WebSocket upgrade handoff.

use super::api::{self, Call};
use super::model::{ApiErr, Shared, actor_of, me, new_id, rand_str};
use super::{API_PREFIX, LoggedRequest, pattern_matches, workspace};
use bytes::Bytes;
use http_body_util::{BodyExt, Full};
use hyper::body::Incoming;
use hyper::{Request, Response};
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::{Map, Value, json};
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Instant;

pub type Resp = Response<Full<Bytes>>;

pub async fn serve(listener: tokio::net::TcpListener, sh: Arc<Shared>) {
    loop {
        let Ok((stream, _)) = listener.accept().await else { continue };
        let _ = stream.set_nodelay(true);
        let sh = sh.clone();
        tokio::spawn(async move {
            let svc = hyper::service::service_fn(move |req| {
                let sh = sh.clone();
                async move { Ok::<_, Infallible>(handle(sh, req).await) }
            });
            let _ = hyper_util::server::conn::auto::Builder::new(TokioExecutor::new()).serve_connection_with_upgrades(TokioIo::new(stream), svc).await;
        });
    }
}

pub fn parse_query(q: &str) -> Vec<(String, String)> {
    q.split('&')
        .filter(|s| !s.is_empty())
        .map(|kv| {
            let (k, v) = kv.split_once('=').unwrap_or((kv, ""));
            (decode(k), decode(v))
        })
        .collect()
}

pub fn decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        match b[i] {
            b'+' => out.push(b' '),
            b'%' if i + 2 < b.len() => {
                match u8::from_str_radix(std::str::from_utf8(&b[i + 1..i + 3]).unwrap_or("zz"), 16) {
                    Ok(v) => {
                        out.push(v);
                        i += 2;
                    }
                    Err(_) => out.push(b'%'),
                }
            }
            c => out.push(c),
        }
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

fn header(req_headers: &[(String, String)], name: &str) -> Option<String> {
    req_headers.iter().find(|(k, _)| k == name).map(|(_, v)| v.clone())
}

/// The actor for a request, from its `User-Agent`.
pub fn request_actor(headers: &[(String, String)]) -> Value {
    match header(headers, "user-agent") {
        Some(ua) if ua.starts_with("opc/") => actor_of(&me(), "opc", Some(&ua)),
        _ => actor_of(&me(), "api", None),
    }
}

/// The key a request carries, from `Authorization: Bearer` or `x-api-key`.
pub fn request_key(headers: &[(String, String)]) -> Option<String> {
    header(headers, "authorization").and_then(|a| a.strip_prefix("Bearer ").map(str::to_string)).or_else(|| header(headers, "x-api-key"))
}

pub fn key_ok(sh: &Shared, key: Option<&str>) -> bool {
    let k = sh.knobs.lock().unwrap();
    match key {
        Some(key) => (key == k.key && !k.revoked) || DEVICE.lock().unwrap().issued.iter().any(|(sk, live)| sk == key && *live),
        None => false,
    }
}

#[derive(Default)]
struct DeviceState {
    /// device_code → polls so far.
    codes: Vec<(String, u32)>,
    /// Keys issued by the exchange, and whether each is still live.
    issued: Vec<(String, bool)>,
}

static DEVICE: std::sync::Mutex<DeviceState> = std::sync::Mutex::new(DeviceState { codes: Vec::new(), issued: Vec::new() });

pub enum Out {
    Json(u16, Value),
    Raw { status: u16, content_type: String, body: Vec<u8>, headers: Vec<(String, String)> },
    Empty(u16),
}

async fn handle(sh: Arc<Shared>, req: Request<Incoming>) -> Resp {
    let started = Instant::now();
    let method = req.method().to_string();
    let full_path = req.uri().path().to_string();
    let query = req.uri().query().unwrap_or("").to_string();
    let headers: Vec<(String, String)> = req.headers().iter().map(|(k, v)| (k.as_str().to_ascii_lowercase(), String::from_utf8_lossy(v.as_bytes()).into_owned())).collect();
    let request_id = new_id("req_");

    let is_upgrade = header(&headers, "upgrade").is_some_and(|u| u.eq_ignore_ascii_case("websocket"));
    if is_upgrade {
        log(&sh, &method, &full_path, &query, &headers, vec![], 101);
        return super::ws::upgrade(sh, req, headers).await;
    }

    let body = match req.into_body().collect().await {
        Ok(b) => b.to_bytes(),
        Err(_) => Bytes::new(),
    };
    let rel = full_path.strip_prefix(API_PREFIX).map(|p| if p.is_empty() { "/".to_string() } else { p.to_string() });
    let path = rel.clone().unwrap_or_else(|| full_path.clone());

    let delays: Vec<_> = sh.knobs.lock().unwrap().delays.iter().filter(|(p, _)| pattern_matches(p, &method, &path)).map(|(_, d)| *d).collect();
    for d in delays {
        tokio::time::sleep(d).await;
    }

    let out = respond(&sh, &method, rel.as_deref(), &path, &query, &headers, body.clone()).await;
    let (status, mut resp) = render(out, &request_id);
    let h = resp.headers_mut();
    h.insert("x-request-id", request_id.parse().unwrap());
    if let Some(v) = sh.knobs.lock().unwrap().latest.clone() {
        h.insert("x-opc-latest", v.parse().unwrap());
    }
    let dur = started.elapsed().as_secs_f64() * 1000.0;
    h.insert("server-timing", format!("total;dur={dur:.1}").parse().unwrap());
    log(&sh, &method, &path, &query, &headers, body.to_vec(), status);
    resp
}

fn log(sh: &Shared, method: &str, path: &str, query: &str, headers: &[(String, String)], body: Vec<u8>, status: u16) {
    let path = path.strip_prefix(API_PREFIX).unwrap_or(path).to_string();
    sh.requests.lock().unwrap().push(LoggedRequest { method: method.into(), path, query: query.into(), headers: headers.to_vec(), body, status });
}

fn render(out: Result<Out, (ApiErr, Vec<(String, String)>)>, request_id: &str) -> (u16, Resp) {
    match out {
        Ok(Out::Json(status, v)) => (status, json_resp(status, &v)),
        Ok(Out::Empty(status)) => (status, Response::builder().status(status).body(Full::new(Bytes::new())).unwrap()),
        Ok(Out::Raw { status, content_type, body, headers }) => {
            let mut b = Response::builder().status(status).header("content-type", content_type);
            for (k, v) in headers {
                b = b.header(k, v);
            }
            (status, b.body(Full::new(Bytes::from(body))).unwrap())
        }
        Err((e, extra_headers)) => {
            let mut r = json_resp(e.status, &e.body(request_id));
            if let Some(ms) = e.extra.get("retryAfterMs").and_then(Value::as_u64)
                && !extra_headers.iter().any(|(k, _)| k == "retry-after")
                && e.status == 429
            {
                r.headers_mut().insert("retry-after", ms.div_ceil(1000).to_string().parse().unwrap());
            }
            for (k, v) in extra_headers {
                r.headers_mut().insert(hyper::header::HeaderName::from_bytes(k.as_bytes()).unwrap(), v.parse().unwrap());
            }
            (e.status, r)
        }
    }
}

fn json_resp(status: u16, v: &Value) -> Resp {
    Response::builder().status(status).header("content-type", "application/json").body(Full::new(Bytes::from(serde_json::to_vec(v).unwrap()))).unwrap()
}

/// Takes an injected failure matching this request, if any.
pub fn take_failure(sh: &Shared, method: &str, path: &str) -> Option<super::Failure> {
    let mut k = sh.knobs.lock().unwrap();
    let i = k.failures.iter().position(|f| f.remaining > 0 && pattern_matches(&f.pattern, method, path))?;
    k.failures[i].remaining -= 1;
    let f = k.failures[i].failure.clone();
    if k.failures[i].remaining == 0 {
        k.failures.remove(i);
    }
    Some(f)
}

async fn respond(sh: &Arc<Shared>, method: &str, rel: Option<&str>, path: &str, query: &str, headers: &[(String, String)], body: Bytes) -> Result<Out, (ApiErr, Vec<(String, String)>)> {
    if let Some(f) = take_failure(sh, method, path) {
        return Err((f.to_err(), f.headers.clone()));
    }
    let Some(rel) = rel else {
        return root(sh, method, path, headers, &body).map_err(|e| (e, vec![]));
    };
    if !key_ok(sh, request_key(headers).as_deref()) {
        return Err((ApiErr::new(401, "unauthenticated", "the key is missing, unknown or revoked"), vec![]));
    }
    api_route(sh, method, rel, query, headers, body).await.map_err(|e| (e, vec![]))
}

fn root(sh: &Arc<Shared>, method: &str, path: &str, headers: &[(String, String)], body: &Bytes) -> Result<Out, ApiErr> {
    let b: Value = serde_json::from_slice(body).unwrap_or(Value::Null);
    match (method, path) {
        ("POST", "/auth/cli/device") => {
            let code = rand_str(32);
            DEVICE.lock().unwrap().codes.push((code.clone(), 0));
            let user = format!("{}-{}", rand_str(4).to_uppercase(), rand_str(4).to_uppercase());
            Ok(Out::Json(
                200,
                json!({
                    "device_code": code, "user_code": user,
                    "verification_uri": format!("{}/cli/device", sh.api_url),
                    "verification_uri_complete": format!("{}/cli/device?code={user}", sh.api_url),
                    "expires_in": 600, "interval": 0,
                }),
            ))
        }
        ("POST", "/auth/cli/device/exchange") => {
            let code = b["device_code"].as_str().unwrap_or("").to_string();
            let name = b["credential_name"].as_str().unwrap_or("opc").to_string();
            let pending = sh.knobs.lock().unwrap().device_pending;
            let mut d = DEVICE.lock().unwrap();
            let Some(entry) = d.codes.iter_mut().find(|(c, _)| *c == code) else {
                return Ok(Out::Json(400, json!({"error": "invalid_grant", "message": "unknown device code"})));
            };
            entry.1 += 1;
            if entry.1 <= pending {
                return Ok(Out::Json(200, json!({"status": "authorization_pending", "retry_after": 0})));
            }
            d.codes.retain(|(c, _)| *c != code);
            let key = format!("opc_live_{}", rand_str(32));
            d.issued.push((key.clone(), true));
            let prefix: String = key.chars().take(12).collect();
            Ok(Out::Json(200, json!({"status": "authorized", "credential": {"id": new_id("key_"), "key": key, "key_prefix": prefix, "name": name}})))
        }
        ("DELETE", "/auth/cli/credential") => {
            let key = request_key(headers);
            if !key_ok(sh, key.as_deref()) {
                return Err(ApiErr::new(401, "unauthenticated", "the key is missing, unknown or revoked"));
            }
            let key = key.unwrap();
            let mut d = DEVICE.lock().unwrap();
            for (k, live) in d.issued.iter_mut() {
                if *k == key {
                    *live = false;
                }
            }
            drop(d);
            let mut k = sh.knobs.lock().unwrap();
            if k.key == key {
                k.revoked = true;
            }
            Ok(Out::Empty(204))
        }
        _ => Err(ApiErr::new(404, "not_found", format!("no route {method} {path}"))),
    }
}

async fn api_route(sh: &Arc<Shared>, method: &str, rel: &str, query: &str, headers: &[(String, String)], body: Bytes) -> Result<Out, ApiErr> {
    let segs: Vec<&str> = rel.trim_matches('/').split('/').collect();
    let mut q = Map::new();
    for (k, v) in parse_query(query) {
        q.insert(k, Value::String(v));
    }
    let actor = request_actor(headers);
    let idem = header(headers, "idempotency-key");

    // Workspace routes take raw bodies.
    if segs.len() >= 3 && segs[0] == "sessions" && segs[2] == "workspace" {
        let sid = segs[1].to_string();
        sh.read(|w| w.sess(&sid).map(|_| ()))?;
        return workspace::handle(sh, method, &sid, &segs[3..].join("/"), &q, headers, body, actor, idem).await;
    }

    let parsed: Value = if body.is_empty() {
        Value::Null
    } else {
        match serde_json::from_slice(&body) {
            Ok(v) => v,
            Err(e) => return Err(ApiErr::bad("body", format!("the body is not JSON: {e}"))),
        }
    };
    let (op, sid, sub): (&str, Option<&str>, Option<&str>) = match (method, segs.as_slice()) {
        ("GET", ["me"]) => ("me", None, None),
        ("POST", ["tickets"]) => ("tickets.create", None, None),
        ("POST", ["sessions"]) => ("sessions.create", None, None),
        ("GET", ["sessions"]) => ("sessions.list", None, None),
        ("GET", ["sessions", id]) => ("sessions.get", Some(id), None),
        ("PATCH", ["sessions", id]) => ("sessions.update", Some(id), None),
        ("GET", ["sessions", id, "capabilities"]) => ("sessions.capabilities", Some(id), None),
        ("POST", ["sessions", id, "interrupt"]) => ("sessions.interrupt", Some(id), None),
        ("POST", ["sessions", id, "compact"]) => ("sessions.compact", Some(id), None),
        ("POST", ["sessions", id, "suspend"]) => ("sessions.suspend", Some(id), None),
        ("POST", ["sessions", id, "resume"]) => ("sessions.resume", Some(id), None),
        ("POST", ["sessions", id, "turns"]) => ("turns.send", Some(id), None),
        ("GET", ["sessions", id, "turns"]) => ("turns.list", Some(id), None),
        ("GET", ["sessions", id, "turns", t]) => ("turns.get", Some(id), Some(t)),
        ("POST", ["sessions", id, "turns", t, "cancel"]) => ("turns.cancel", Some(id), Some(t)),
        ("GET", ["sessions", id, "events"]) => ("events.list", Some(id), None),
        ("GET", ["sessions", id, "asks"]) => ("asks.list", Some(id), None),
        ("GET", ["sessions", id, "asks", a]) => ("asks.get", Some(id), Some(a)),
        ("POST", ["sessions", id, "asks", a, "answer"]) => ("asks.answer", Some(id), Some(a)),
        ("POST", ["sessions", id, "asks", a, "dismiss"]) => ("asks.dismiss", Some(id), Some(a)),
        ("GET", ["sessions", id, "subagents"]) => ("subagents.list", Some(id), None),
        ("GET", ["sessions", id, "subagents", x]) => ("subagents.get", Some(id), Some(x)),
        ("POST", ["sessions", id, "subagents", x, "stop"]) => ("subagents.stop", Some(id), Some(x)),
        // As on the server: secrets are set in Slack only.
        (_, ["sessions", _, "secrets", ..] | ["me" | "organization", "secrets", ..] | ["secrets", ..]) => {
            return Err(ApiErr::new(409, "feature_unavailable", "secrets are set in Slack"));
        }
        _ => return Err(ApiErr::new(404, "not_found", format!("no route {method} {rel}"))),
    };
    let call = Call { op: op.into(), sid: sid.map(str::to_string), sub: sub.map(str::to_string), query: q, body: parsed, idem, actor, strict_body: true };
    let (status, v) = api::dispatch(sh, call).await?;
    Ok(if status == 204 { Out::Empty(204) } else { Out::Json(status, v) })
}
