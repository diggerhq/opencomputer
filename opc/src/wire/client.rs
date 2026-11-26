//! One WebSocket connection: the dial (key on the upgrade, attach in the URL,
//! `TCP_NODELAY`, resumed TLS, CONNECT through a proxy) and the frame pumps.

use super::{Attach, PROTOCOL, WireOptions};
use crate::error::{Error, Result};
use crate::net::{self, Target};
use bytes::Bytes;
use futures_util::{SinkExt, StreamExt};
use serde_json::Value;
use std::time::{Duration, Instant};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::{self, Message, client::IntoClientRequest, protocol::CloseFrame};

/// A frame from the server, parsed off the actor's task.
#[derive(Debug)]
pub enum Frame {
    Json(Value),
    Binary(u32, Bytes),
    /// The connection ended: the close code (1006 when there was none).
    Closed { code: u16, reason: String },
}

/// The upgrade URL: `?attach=…&after=…&tailTurns=…&deltas=1&resume=1`.
/// Only sessions of one shape go in the URL, since `after` and `tailTurns`
/// pair with `attach` by position; the rest are attached with a request.
pub fn upgrade_url(base: &str, attaches: &[Attach], opts: &WireOptions) -> (String, Vec<String>) {
    let mut q: Vec<(String, String)> = Vec::new();
    let mut in_url = Vec::new();
    if !opts.read_only {
        let shape = |a: &Attach| (a.after.is_some(), a.tail_turns.is_some());
        if let Some(first) = attaches.first() {
            let s = shape(first);
            for a in attaches.iter().filter(|a| shape(a) == s).take(20) {
                q.push(("attach".into(), a.session_id.clone()));
                if let Some(after) = a.after {
                    q.push(("after".into(), after.to_string()));
                }
                if let Some(t) = a.tail_turns {
                    q.push(("tailTurns".into(), t.to_string()));
                }
                in_url.push(a.session_id.clone());
            }
            if !in_url.is_empty() {
                if opts.deltas {
                    q.push(("deltas".into(), "1".into()));
                }
                if opts.resume {
                    q.push(("resume".into(), "1".into()));
                }
            }
        }
    }
    (format!("{}{}", base.trim_end_matches('/').trim_end_matches('?'), net::query_string(&q)), in_url)
}

pub struct Dialed {
    pub tx: mpsc::UnboundedSender<Message>,
    pub took: Duration,
    pub resumed_tls: bool,
    /// Frames and bytes received (telemetry's `cli.connection`).
    pub counts: std::sync::Arc<crate::telemetry::ConnCounts>,
}

/// Dials and starts the reader and writer tasks. Frames arrive on `frames`,
/// tagged with `generation`.
pub async fn dial(url: &str, key: &str, generation: u64, frames: mpsc::UnboundedSender<(u64, Frame)>) -> Result<Dialed> {
    let started = Instant::now();
    let target = Target::parse(url)?;
    let stream = net::connect(&target, &[b"http/1.1"]).await?;
    let resumed_tls = stream.resumed();
    let mut req = url.into_client_request().map_err(|e| Error::usage(format!("bad wire URL: {e}")))?;
    {
        let h = req.headers_mut();
        h.insert("sec-websocket-protocol", http::HeaderValue::from_static(PROTOCOL));
        let mut v = http::HeaderValue::from_str(key).map_err(|_| Error::new("unauthenticated", "the API key has characters a header cannot carry"))?;
        v.set_sensitive(true);
        h.insert("x-api-key", v);
        h.insert(http::header::USER_AGENT, http::HeaderValue::from_str(&crate::http::user_agent()).expect("ascii"));
    }
    let mut config = tungstenite::protocol::WebSocketConfig::default();
    config.max_message_size = Some(64 << 20);
    config.max_frame_size = Some(16 << 20);
    let (ws, response) = tokio_tungstenite::client_async_with_config(req, stream, Some(config))
        .await
        .map_err(handshake_error)?;
    if let Some(p) = response.headers().get("sec-websocket-protocol").and_then(|v| v.to_str().ok())
        && p != PROTOCOL {
            return Err(Error::new("upgrade_required", format!("the server chose protocol {p}; this opc speaks {PROTOCOL}")));
        }
    let took = started.elapsed();
    let (mut sink, mut source) = ws.split();
    let (tx, mut rx) = mpsc::unbounded_channel::<Message>();

    // Writer: drains the queue, flushing once per burst. While it runs, an
    // exiting opc waits briefly for it so the last telemetry frame and the
    // close go out (`telemetry::drain`).
    let live = crate::telemetry::LiveWriter::new();
    tokio::spawn(async move {
        let _live = live;
        while let Some(msg) = rx.recv().await {
            let closing = matches!(msg, Message::Close(_));
            if sink.feed(msg).await.is_err() {
                return;
            }
            while let Ok(more) = rx.try_recv() {
                if sink.feed(more).await.is_err() {
                    return;
                }
            }
            if sink.flush().await.is_err() || closing {
                let _ = sink.close().await;
                return;
            }
        }
        let _ = sink.close().await;
    });

    // Reader: parses frames as they arrive.
    let counts = crate::telemetry::ConnCounts::new();
    let reader_counts = counts.clone();
    tokio::spawn(async move {
        let mut close = (1006u16, String::new());
        while let Some(msg) = source.next().await {
            if let Ok(m @ (Message::Text(_) | Message::Binary(_))) = &msg {
                reader_counts.frame(m.len());
            }
            match msg {
                Ok(Message::Text(t)) => match serde_json::from_str::<Value>(t.as_str()) {
                    Ok(v) => {
                        if frames.send((generation, Frame::Json(v))).is_err() {
                            return;
                        }
                    }
                    Err(e) => crate::log::warn(&format!("wire: a frame that is not JSON: {e}")),
                },
                Ok(Message::Binary(b)) => {
                    if b.len() >= 4 {
                        let channel = u32::from_be_bytes([b[0], b[1], b[2], b[3]]);
                        if frames.send((generation, Frame::Binary(channel, b.slice(4..)))).is_err() {
                            return;
                        }
                    }
                }
                Ok(Message::Close(frame)) => {
                    if let Some(CloseFrame { code, reason }) = frame {
                        close = (u16::from(code), reason.as_str().to_string());
                    } else {
                        close = (1005, String::new());
                    }
                    break;
                }
                Ok(_) => {}
                Err(e) => {
                    close = (1006, e.to_string());
                    break;
                }
            }
        }
        let _ = frames.send((generation, Frame::Closed { code: close.0, reason: close.1 }));
    });

    Ok(Dialed { tx, took, resumed_tls, counts })
}

fn handshake_error(e: tungstenite::Error) -> Error {
    match e {
        tungstenite::Error::Http(resp) => {
            let status = resp.status().as_u16();
            let body: Value = resp.body().as_ref().and_then(|b| serde_json::from_slice(b).ok()).unwrap_or(Value::Null);
            let mut err = crate::http::api_error(status, &body, resp.headers());
            if body.is_null() && status >= 500 {
                err = Error::new("computer_unavailable", format!("the wire answered {status}"));
                err.status = Some(status);
            }
            err
        }
        other => Error::unreachable(format!("cannot open the connection to your computer: {other}")),
    }
}

/// Encodes terminal data for a channel.
pub fn binary_frame(channel: u32, data: &[u8]) -> Message {
    let mut buf = Vec::with_capacity(4 + data.len());
    buf.extend_from_slice(&channel.to_be_bytes());
    buf.extend_from_slice(data);
    Message::Binary(Bytes::from(buf))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn opts() -> WireOptions {
        WireOptions { url: "wss://w/v1".into(), key: "k".into(), deltas: true, resume: false, read_only: false, give_up: None }
    }

    #[test]
    fn url_pairs_by_position() {
        let a = vec![
            Attach { session_id: "cs_a".into(), after: Some(5), ..Default::default() },
            Attach { session_id: "cs_b".into(), after: Some(9), ..Default::default() },
            Attach { session_id: "cs_c".into(), tail_turns: Some(1), ..Default::default() },
        ];
        let (url, in_url) = upgrade_url("wss://w/v1", &a, &opts());
        assert_eq!(url, "wss://w/v1?attach=cs_a&after=5&attach=cs_b&after=9&deltas=1");
        assert_eq!(in_url, vec!["cs_a", "cs_b"]);
    }

    #[test]
    fn no_credentials_in_the_url() {
        let a = vec![Attach { session_id: "cs_a".into(), ..Default::default() }];
        let (url, _) = upgrade_url("wss://w/v1", &a, &opts());
        assert!(!url.contains('k') || !url.contains("key"));
        let (url, in_url) = upgrade_url("wss://w/v1", &a, &WireOptions { read_only: true, ..opts() });
        assert_eq!(url, "wss://w/v1");
        assert!(in_url.is_empty());
    }
}
