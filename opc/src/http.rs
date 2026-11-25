//! The API client: hyper over one HTTP/2 connection per process (HTTP/1.1
//! when the server offers nothing else), `TCP_NODELAY`, resumed TLS, CONNECT
//! through `HTTPS_PROXY`.
//!
//! Every write carries an `Idempotency-Key` (the caller's derived key, or a
//! random one held across retries). `429` and `503` are retried after
//! `retryAfterMs` for as long as the deadline allows. `Server-Timing` and
//! `x-request-id` are read on every response.

use crate::config::Config;
use crate::error::{Error, Result};
use crate::net::{self, Stream, Target};
use crate::timing;
use bytes::Bytes;
use http::{HeaderMap, HeaderValue, Method, Request, StatusCode};
use http_body_util::{BodyExt, Empty, Full, combinators::BoxBody};
use hyper::body::Incoming;
use hyper::client::conn::{http1, http2};
use hyper_util::rt::{TokioExecutor, TokioIo};
use serde_json::Value;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex as StdMutex, OnceLock};
use std::time::{Duration, Instant};
use tokio::sync::Mutex;

pub type Body = BoxBody<Bytes, std::io::Error>;

/// A cold computer answers `503 computer_unavailable` while it starts; the
/// request is retried with the same `Idempotency-Key`. Whether that is
/// happening now, for the status line.
static COMPUTER_STARTING: AtomicBool = AtomicBool::new(false);
type Notice = Box<dyn Fn() + Send>;
static STARTING_NOTICE: StdMutex<Option<Notice>> = StdMutex::new(None);

/// What to do the first time a request waits for a cold computer (print a
/// line, or nothing where the screen shows it).
pub fn set_starting_notice(f: Option<Notice>) {
    *STARTING_NOTICE.lock().unwrap_or_else(|e| e.into_inner()) = f;
}

/// A request is waiting for the computer to start.
pub fn computer_starting() -> bool {
    COMPUTER_STARTING.load(Ordering::Relaxed)
}

fn mark_computer_starting(on: bool) {
    if COMPUTER_STARTING.swap(on, Ordering::Relaxed) != on && on
        && let Some(f) = STARTING_NOTICE.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
            f();
        }
}

pub const VERSION: &str = env!("CARGO_PKG_VERSION");

pub fn user_agent() -> String {
    format!("opc/{VERSION}")
}

pub fn empty() -> Body {
    Empty::<Bytes>::new().map_err(|never| match never {}).boxed()
}

pub fn full(bytes: impl Into<Bytes>) -> Body {
    Full::new(bytes.into()).map_err(|never| match never {}).boxed()
}

/// How long to keep retrying `429`/`503` when the command has no `--timeout`.
const DEFAULT_RETRY_BUDGET: Duration = Duration::from_secs(60);

/// How long a connection (TCP, TLS, HTTP/2) may take, like the wire's dial.
const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// The newest version the server told us about (`x-opc-latest`).
static LATEST: OnceLock<String> = OnceLock::new();

pub fn latest_version() -> Option<&'static str> {
    LATEST.get().map(String::as_str)
}

#[derive(Debug)]
pub struct Response {
    pub status: u16,
    pub headers: HeaderMap,
    pub body: Value,
    pub server: Option<Duration>,
    pub request_id: Option<String>,
    pub took: Duration,
}

enum Sender {
    H2(http2::SendRequest<Body>),
    H1(http1::SendRequest<Body>),
}

struct Inner {
    api_url: String,
    base_path: String,
    target: Target,
    key: Option<String>,
    h2: Mutex<Option<http2::SendRequest<Body>>>,
    h1_idle: StdMutex<Vec<http1::SendRequest<Body>>>,
    /// Set once we learn the server speaks HTTP/1.1 only.
    h1_only: AtomicBool,
    deadline: StdMutex<Option<Instant>>,
}

/// Cheap to clone; every clone shares the connection.
#[derive(Clone)]
pub struct Http {
    inner: Arc<Inner>,
}

impl Http {
    pub fn new(config: &Config) -> Result<Http> {
        let target = Target::parse(&config.api_url)?;
        let base_path = format!("{}{}", target.path.trim_end_matches('/'), crate::config::API_PREFIX);
        Ok(Http {
            inner: Arc::new(Inner {
                api_url: config.api_url.clone(),
                base_path,
                target,
                key: config.api_key.clone(),
                h2: Mutex::new(None),
                h1_idle: StdMutex::new(Vec::new()),
                h1_only: AtomicBool::new(false),
                deadline: StdMutex::new(None),
            }),
        })
    }

    pub fn api_url(&self) -> &str {
        &self.inner.api_url
    }

    pub fn has_key(&self) -> bool {
        self.inner.key.is_some()
    }

    /// Bounds retries of `429`/`503`: `--timeout`'s deadline.
    pub fn set_deadline(&self, deadline: Option<Instant>) {
        *self.inner.deadline.lock().unwrap_or_else(|e| e.into_inner()) = deadline;
    }

    fn deadline(&self) -> Option<Instant> {
        *self.inner.deadline.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// When retries of `429`/`503` must stop: `--timeout`, or
    /// [`DEFAULT_RETRY_BUDGET`] from now.
    pub fn retry_budget_end(&self) -> Instant {
        self.deadline().unwrap_or_else(|| Instant::now() + DEFAULT_RETRY_BUDGET)
    }

    /// How long to wait before repeating a request that failed with `err`
    /// (`429`/`503` only), or `None` when it must not be repeated before
    /// `budget_end`. A cold computer turns on the "starting" notice.
    pub fn retry_wait(&self, err: &Error, attempt: u32, budget_end: Instant) -> Option<Duration> {
        if !matches!(err.status, Some(429 | 503)) {
            return None;
        }
        let wait = Duration::from_millis(err.retry_after_ms().unwrap_or(500 * u64::from(attempt.clamp(1, 8))));
        if Instant::now() + wait >= budget_end {
            return None;
        }
        if err.code == "computer_unavailable" {
            mark_computer_starting(true);
        }
        crate::log::info(&format!("{} {}: retrying in {}", err.status.unwrap_or(0), err.code, timing::ms(wait)));
        Some(wait)
    }

    /// Opens the connection now, so the first request does not pay for it.
    pub fn warm(&self) {
        let me = self.clone();
        tokio::spawn(async move {
            if let Ok(Sender::H1(s)) = me.sender().await {
                me.inner.h1_idle.lock().unwrap_or_else(|e| e.into_inner()).push(s);
            }
        });
    }

    async fn connect(&self) -> Result<Sender> {
        let started = Instant::now();
        let alpn: &[&[u8]] = if self.inner.h1_only.load(Ordering::Relaxed) { &[b"http/1.1"] } else { &[b"h2", b"http/1.1"] };
        // Bounded by CONNECT_TIMEOUT and by `--timeout`, whichever ends first:
        // a firewall that drops SYNs would otherwise hold us for minutes.
        let limit = self.deadline().map_or(CONNECT_TIMEOUT, |d| d.saturating_duration_since(started).min(CONNECT_TIMEOUT));
        let stream: Stream = match tokio::time::timeout(limit, net::connect(&self.inner.target, alpn)).await {
            Ok(r) => r?,
            Err(_) if limit < CONNECT_TIMEOUT => return Err(Error::timeout()),
            Err(_) => return Err(Error::unreachable(format!("could not connect to {} within {} s", self.inner.target.authority(), CONNECT_TIMEOUT.as_secs()))),
        };
        let h2 = stream.alpn() == Some(b"h2");
        let resumed = stream.resumed();
        let io = TokioIo::new(stream);
        let sender = if h2 {
            let mut builder = http2::Builder::new(TokioExecutor::new());
            builder
                .initial_stream_window_size(4 << 20)
                .initial_connection_window_size(8 << 20)
                .keep_alive_interval(Some(Duration::from_secs(20)))
                .keep_alive_timeout(Duration::from_secs(10))
                .keep_alive_while_idle(true)
                .timer(hyper_util::rt::TokioTimer::new());
            let (send, conn) = builder.handshake(io).await.map_err(|e| Error::unreachable(format!("HTTP/2 handshake: {e}")))?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Sender::H2(send)
        } else {
            self.inner.h1_only.store(true, Ordering::Relaxed);
            let (send, conn) = http1::Builder::new()
                .handshake(io)
                .await
                .map_err(|e| Error::unreachable(format!("HTTP handshake: {e}")))?;
            tokio::spawn(async move {
                let _ = conn.await;
            });
            Sender::H1(send)
        };
        crate::log::debug(&format!(
            "connected to {} in {} ({}{})",
            self.inner.target.authority(),
            timing::ms(started.elapsed()),
            if h2 { "h2" } else { "http/1.1" },
            if resumed { ", TLS resumed" } else { "" }
        ));
        Ok(sender)
    }

    async fn sender(&self) -> Result<Sender> {
        if !self.inner.h1_only.load(Ordering::Relaxed) {
            let mut slot = self.inner.h2.lock().await;
            if let Some(s) = slot.as_ref().filter(|s| !s.is_closed()) {
                return Ok(Sender::H2(s.clone()));
            }
            *slot = None;
            return match self.connect().await? {
                Sender::H2(s) => {
                    *slot = Some(s.clone());
                    Ok(Sender::H2(s))
                }
                h1 => Ok(h1),
            };
        }
        loop {
            let idle = self.inner.h1_idle.lock().unwrap_or_else(|e| e.into_inner()).pop();
            match idle {
                Some(s) if !s.is_closed() => return Ok(Sender::H1(s)),
                Some(_) => continue,
                None => return self.connect().await,
            }
        }
    }

    fn uri_for(&self, path: &str, h2: bool) -> String {
        let t = &self.inner.target;
        if h2 {
            format!("{}://{}{}", if t.tls { "https" } else { "http" }, t.authority(), path)
        } else {
            path.to_string()
        }
    }

    /// Sends one request on the shared connection. `path` is absolute on the
    /// host (it already includes the API's prefix).
    async fn send_once(&self, method: &Method, path: &str, headers: &[(&str, String)], body: Body) -> Result<http::Response<Incoming>> {
        let sender = self.sender().await?;
        let h2 = matches!(sender, Sender::H2(_));
        let mut req = Request::builder().method(method.clone()).uri(self.uri_for(path, h2));
        if !h2 {
            req = req.header(http::header::HOST, self.inner.target.authority());
        }
        req = req.header(http::header::USER_AGENT, user_agent());
        if let Some(k) = &self.inner.key {
            let mut v = HeaderValue::from_str(k).map_err(|_| Error::new("unauthenticated", "the API key has characters a header cannot carry"))?;
            v.set_sensitive(true);
            req = req.header("x-api-key", v);
        }
        for (name, value) in headers {
            req = req.header(*name, value.as_str());
        }
        let req = req.body(body).map_err(|e| Error::usage(format!("bad request: {e}")))?;
        let res = match sender {
            Sender::H2(mut s) => s.send_request(req).await,
            Sender::H1(mut s) => {
                let r = s.send_request(req).await;
                if r.is_ok() {
                    // Reusable once this response's body is read; the pool
                    // checks `is_ready` lazily through `is_closed`.
                    let me = self.clone();
                    tokio::spawn(async move {
                        if s.ready().await.is_ok() {
                            me.inner.h1_idle.lock().unwrap_or_else(|e| e.into_inner()).push(s);
                        }
                    });
                }
                r
            }
        };
        res.map_err(|e| Error::unreachable(format!("request to {} failed: {e}", self.inner.target.host)))
    }

    /// A JSON request under the Computer API's prefix, with retries.
    pub async fn call(&self, method: Method, path: &str, query: &[(String, String)], body: Option<&Value>, idempotency_key: Option<&str>) -> Result<Response> {
        let full = format!("{}{}{}", self.inner.base_path, path, net::query_string(query));
        self.call_at(method, &full, body, idempotency_key, true).await
    }

    /// A JSON request at the root of the API's host (`/auth/cli/…`).
    pub async fn call_root(&self, method: Method, path: &str, body: Option<&Value>) -> Result<Response> {
        let full = format!("{}{}", self.inner.target.path.trim_end_matches('/'), path);
        self.call_at(method, &full, body, None, false).await
    }

    async fn call_at(&self, method: Method, full_path: &str, body: Option<&Value>, idempotency_key: Option<&str>, needs_key: bool) -> Result<Response> {
        if needs_key && self.inner.key.is_none() {
            return Err(Error::not_logged_in());
        }
        let is_write = !matches!(method, Method::GET | Method::HEAD);
        let key = match idempotency_key {
            Some(k) => Some(k.to_string()),
            None if is_write && needs_key => Some(crate::ids::idempotency_key()),
            None => None,
        };
        let body_bytes = body.map(serde_json::to_vec).transpose()?;
        let label = format!("{} {}", method, full_path.split('?').next().unwrap_or(full_path).replace(&self.inner.base_path, ""));
        let budget_end = self.retry_budget_end();
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let mut headers: Vec<(&str, String)> = vec![("accept", "application/json".into())];
            if body_bytes.is_some() {
                headers.push(("content-type", "application/json".into()));
            }
            if let Some(k) = &key {
                headers.push(("idempotency-key", k.clone()));
            }
            let b = match &body_bytes {
                Some(bytes) => full(bytes.clone()),
                None => empty(),
            };
            let started = Instant::now();
            let sent = match self.deadline() {
                Some(d) => tokio::time::timeout_at(d.into(), self.send_once(&method, full_path, &headers, b)).await.unwrap_or_else(|_| Err(Error::timeout())),
                None => self.send_once(&method, full_path, &headers, b).await,
            };
            let res = match sent {
                Ok(r) => r,
                Err(e) if e.code == "timeout" => return Err(e),
                Err(e) => {
                    // A connection that died under us: retry once on a fresh
                    // one. Safe: reads are idempotent and writes carry a key.
                    // Not after a connect that timed out: it would again.
                    if attempt == 1 && started.elapsed() < CONNECT_TIMEOUT && (key.is_some() || !is_write) {
                        *self.inner.h2.lock().await = None;
                        continue;
                    }
                    return Err(e);
                }
            };
            let status = res.status();
            let headers = res.headers().clone();
            note_latest(&headers);
            let server = headers.get("server-timing").and_then(|v| v.to_str().ok()).and_then(timing::parse_server_timing);
            let request_id = headers.get("x-request-id").and_then(|v| v.to_str().ok()).map(str::to_string);
            let body = res.into_body().collect();
            let bytes = match self.deadline() {
                Some(d) => tokio::time::timeout_at(d.into(), body).await.map_err(|_| Error::timeout())?,
                None => body.await,
            }
            .map_err(|e| Error::unreachable(format!("reading the response: {e}")))?
            .to_bytes();
            let took = started.elapsed();
            timing::get().request(&label, took, server);
            crate::log::debug(&format!("{label} → {} in {}{}", status.as_u16(), timing::ms(took), request_id.as_ref().map(|r| format!(" ({r})")).unwrap_or_default()));
            let value: Value = if bytes.is_empty() || status == StatusCode::NO_CONTENT {
                Value::Null
            } else {
                serde_json::from_slice(&bytes).unwrap_or_else(|_| Value::String(String::from_utf8_lossy(&bytes).into_owned()))
            };
            if status.is_success() {
                mark_computer_starting(false);
                return Ok(Response { status: status.as_u16(), headers, body: value, server, request_id, took });
            }
            let mut err = api_error(status.as_u16(), &value, &headers);
            if let Some(r) = &request_id {
                err.extra.entry("requestId").or_insert_with(|| Value::String(r.clone()));
            }
            if let Some(wait) = self.retry_wait(&err, attempt, budget_end) {
                tokio::time::sleep(wait).await;
                continue;
            }
            return Err(err);
        }
    }

    /// A streaming request: the body is sent as given and the response is
    /// returned unread when it succeeds. Errors are read and mapped.
    pub async fn stream(&self, method: Method, path: &str, query: &[(String, String)], headers: &[(&str, String)], body: Body, idempotency_key: Option<&str>) -> Result<http::Response<Incoming>> {
        if self.inner.key.is_none() {
            return Err(Error::not_logged_in());
        }
        let full_path = format!("{}{}{}", self.inner.base_path, path, net::query_string(query));
        let mut hs: Vec<(&str, String)> = headers.to_vec();
        if let Some(k) = idempotency_key {
            hs.push(("idempotency-key", k.to_string()));
        }
        // A GET has no body to replay, so `429`/`503` are retried here; a
        // caller with a body retries itself (`retry_wait`).
        let budget_end = self.retry_budget_end();
        let mut body = Some(body);
        let mut attempt = 0u32;
        loop {
            attempt += 1;
            let b = body.take().unwrap_or_else(empty);
            let started = Instant::now();
            let res = self.send_once(&method, &full_path, &hs, b).await?;
            let status = res.status();
            note_latest(res.headers());
            let server = res.headers().get("server-timing").and_then(|v| v.to_str().ok()).and_then(timing::parse_server_timing);
            timing::get().request(&format!("{method} {path}"), started.elapsed(), server);
            if status.is_success() {
                mark_computer_starting(false);
                return Ok(res);
            }
            let headers = res.headers().clone();
            let bytes = res.into_body().collect().await.map(|c| c.to_bytes()).unwrap_or_default();
            let value: Value = serde_json::from_slice(&bytes).unwrap_or(Value::Null);
            let err = api_error(status.as_u16(), &value, &headers);
            if method == Method::GET
                && let Some(wait) = self.retry_wait(&err, attempt, budget_end)
            {
                tokio::time::sleep(wait).await;
                continue;
            }
            return Err(err);
        }
    }

    // ---- typed helpers -------------------------------------------------

    pub async fn get(&self, path: &str, query: &[(String, String)]) -> Result<Value> {
        Ok(self.call(Method::GET, path, query, None, None).await?.body)
    }

    pub async fn post(&self, path: &str, body: &Value, key: Option<&str>) -> Result<Value> {
        Ok(self.call(Method::POST, path, &[], Some(body), key).await?.body)
    }

    pub async fn patch(&self, path: &str, body: &Value) -> Result<Value> {
        Ok(self.call(Method::PATCH, path, &[], Some(body), None).await?.body)
    }
}

fn note_latest(headers: &HeaderMap) {
    if let Some(v) = headers.get("x-opc-latest").and_then(|v| v.to_str().ok()) {
        let _ = LATEST.set(v.to_string());
    }
}

/// Maps an error response, filling in what the API leaves implicit.
pub fn api_error(status: u16, body: &Value, headers: &HeaderMap) -> Error {
    let mut err = Error::from_api(status, body);
    if err.retry_after_ms().is_none()
        && let Some(s) = headers.get("retry-after").and_then(|v| v.to_str().ok()).and_then(|v| v.trim().parse::<f64>().ok()) {
            err.extra.insert("retryAfterMs".into(), Value::from((s * 1000.0) as u64));
        }
    match err.code.as_str() {
        "upgrade_required" => {
            let min = err.extra.get("minVersion").and_then(Value::as_str).unwrap_or("a newer version").to_string();
            err.message = format!("this version of opc ({VERSION}) is no longer supported: install opc {min} or newer");
            err.hint = Some("see https://github.com/diggerhq/opc#install".into());
        }
        "unauthenticated" => {
            err.hint = Some("run `opc login`, or check OPENCOMPUTER_API_KEY".into());
        }
        _ => {}
    }
    err
}

/// Builds `/sessions/{id}…` paths with the id encoded.
pub fn session_path(id: &str, rest: &str) -> String {
    format!("/sessions/{}{rest}", net::encode(id))
}

pub fn q(pairs: &[(&str, &str)]) -> Vec<(String, String)> {
    pairs.iter().map(|(k, v)| ((*k).to_string(), (*v).to_string())).collect()
}
