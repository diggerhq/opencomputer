//! Connections: TCP with `TCP_NODELAY`, a staggered dial over every address
//! (happy eyeballs), `CONNECT` through `HTTPS_PROXY`, and TLS with the
//! platform's verifier and one process-wide session cache, so the API
//! connection and the WebSocket resume each other's TLS sessions.

use crate::error::{Error, Result};
use std::io;
use std::net::SocketAddr;
use std::pin::Pin;
use std::sync::{Arc, OnceLock};
use std::task::{Context, Poll};
use std::time::Duration;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt, ReadBuf};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;
use tokio_rustls::client::TlsStream;

/// Where to connect: parsed from an `http(s)://` or `ws(s)://` URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub tls: bool,
    pub host: String,
    pub port: u16,
    /// Path and query, starting with `/`.
    pub path: String,
}

impl Target {
    pub fn parse(url: &str) -> Result<Target> {
        let (scheme, rest) = url.split_once("://").ok_or_else(|| Error::usage(format!("not a URL: {url}")))?;
        let tls = match scheme {
            "https" | "wss" => true,
            "http" | "ws" => false,
            _ => return Err(Error::usage(format!("unsupported URL scheme: {url}"))),
        };
        let (authority, path) = match rest.find(['/', '?']) {
            Some(i) if rest.as_bytes()[i] == b'/' => (&rest[..i], rest[i..].to_string()),
            Some(i) => (&rest[..i], format!("/{}", &rest[i..])),
            None => (rest, "/".to_string()),
        };
        if authority.contains('@') {
            return Err(Error::usage("credentials never go in a URL"));
        }
        let (host, port) = split_host_port(authority, if tls { 443 } else { 80 })?;
        Ok(Target { tls, host, port, path })
    }

    /// `host:port`, with brackets for IPv6.
    pub fn authority(&self) -> String {
        let default = if self.tls { 443 } else { 80 };
        let host = if self.host.contains(':') { format!("[{}]", self.host) } else { self.host.clone() };
        if self.port == default { host } else { format!("{host}:{}", self.port) }
    }
}

fn split_host_port(authority: &str, default: u16) -> Result<(String, u16)> {
    if let Some(rest) = authority.strip_prefix('[') {
        let (h, after) = rest.split_once(']').ok_or_else(|| Error::usage("bad IPv6 address"))?;
        let port = after.strip_prefix(':').map(|p| p.parse()).transpose().map_err(|_| Error::usage("bad port"))?;
        return Ok((h.to_string(), port.unwrap_or(default)));
    }
    match authority.rsplit_once(':') {
        Some((h, p)) => Ok((h.to_string(), p.parse().map_err(|_| Error::usage(format!("bad port in {authority}")))?)),
        None => Ok((authority.to_string(), default)),
    }
}

/// A connected stream, plain or TLS. `alpn` is the negotiated protocol.
pub enum Stream {
    Plain(TcpStream),
    Tls(Box<TlsStream<TcpStream>>),
}

impl Stream {
    pub fn alpn(&self) -> Option<&[u8]> {
        match self {
            Stream::Plain(_) => None,
            Stream::Tls(s) => s.get_ref().1.alpn_protocol(),
        }
    }

    /// Whether the TLS handshake resumed an earlier session.
    pub fn resumed(&self) -> bool {
        match self {
            Stream::Plain(_) => false,
            Stream::Tls(s) => matches!(s.get_ref().1.handshake_kind(), Some(rustls::HandshakeKind::Resumed)),
        }
    }
}

impl AsyncRead for Stream {
    fn poll_read(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &mut ReadBuf<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_read(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_read(cx, buf),
        }
    }
}

impl AsyncWrite for Stream {
    fn poll_write(self: Pin<&mut Self>, cx: &mut Context<'_>, buf: &[u8]) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write(cx, buf),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write(cx, buf),
        }
    }
    fn poll_flush(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_flush(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_flush(cx),
        }
    }
    fn poll_shutdown(self: Pin<&mut Self>, cx: &mut Context<'_>) -> Poll<io::Result<()>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_shutdown(cx),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_shutdown(cx),
        }
    }
    fn poll_write_vectored(
        self: Pin<&mut Self>,
        cx: &mut Context<'_>,
        bufs: &[io::IoSlice<'_>],
    ) -> Poll<io::Result<usize>> {
        match self.get_mut() {
            Stream::Plain(s) => Pin::new(s).poll_write_vectored(cx, bufs),
            Stream::Tls(s) => Pin::new(s.as_mut()).poll_write_vectored(cx, bufs),
        }
    }
    fn is_write_vectored(&self) -> bool {
        match self {
            Stream::Plain(s) => s.is_write_vectored(),
            Stream::Tls(s) => s.is_write_vectored(),
        }
    }
}

/// The TLS configuration for a set of ALPN protocols. All of them share one
/// resumption store, so a ticket from the API's host is reused by the next
/// connection to it in this process.
fn tls_config(alpn: &[&[u8]]) -> Result<Arc<rustls::ClientConfig>> {
    static STORE: OnceLock<Arc<dyn rustls::client::ClientSessionStore>> = OnceLock::new();
    static H2: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    static H1: OnceLock<Arc<rustls::ClientConfig>> = OnceLock::new();
    let slot = if alpn.first() == Some(&&b"h2"[..]) { &H2 } else { &H1 };
    if let Some(c) = slot.get() {
        return Ok(c.clone());
    }
    use rustls_platform_verifier::BuilderVerifierExt;
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut config = rustls::ClientConfig::builder_with_provider(provider)
        .with_safe_default_protocol_versions()
        .map_err(|e| Error::unreachable(format!("TLS setup failed: {e}")))?
        .with_platform_verifier()
        .map_err(|e| Error::unreachable(format!("TLS setup failed: {e}")))?
        .with_no_client_auth();
    config.alpn_protocols = alpn.iter().map(|p| p.to_vec()).collect();
    let store = STORE.get_or_init(|| Arc::new(rustls::client::ClientSessionMemoryCache::new(64))).clone();
    config.resumption = rustls::client::Resumption::store(store);
    let config = Arc::new(config);
    let _ = slot.set(config.clone());
    Ok(slot.get().cloned().unwrap_or(config))
}

/// Warms the TLS configuration (loads the platform's roots) off the hot path.
pub fn prewarm_tls() {
    let _ = tls_config(&[b"h2", b"http/1.1"]);
    let _ = tls_config(&[b"http/1.1"]);
}

/// The proxy to use for `host`, from `HTTPS_PROXY`/`https_proxy`, unless
/// `NO_PROXY` names it.
pub fn proxy_for(host: &str) -> Option<String> {
    // `ALL_PROXY` is often a SOCKS proxy (ssh -D) meant for other tools:
    // it is used only when it is an http:// one.
    let proxy = env_any(&["HTTPS_PROXY", "https_proxy"]).or_else(|| {
        env_any(&["ALL_PROXY", "all_proxy"]).filter(|p| !p.contains("://") || p.to_ascii_lowercase().starts_with("http://"))
    })?;
    if let Some(no) = env_any(&["NO_PROXY", "no_proxy"]) {
        let h = host.trim_start_matches('[').trim_end_matches(']').to_ascii_lowercase();
        for entry in no.split(',').map(|e| e.trim().to_ascii_lowercase()) {
            if entry.is_empty() {
                continue;
            }
            if entry == "*" {
                return None;
            }
            let entry = entry.split(':').next().unwrap_or(&entry).trim_start_matches('*');
            let bare = entry.trim_start_matches('.');
            if h == bare || h.ends_with(&format!(".{bare}")) {
                return None;
            }
        }
    }
    Some(proxy)
}

fn env_any(names: &[&str]) -> Option<String> {
    names.iter().find_map(|n| std::env::var(n).ok().filter(|v| !v.trim().is_empty()))
}

/// Opens a TCP connection to `host:port`, trying every address with a 250 ms
/// stagger and keeping the first to connect. An attempt that fails starts the
/// next one at once (RFC 8305): without IPv6, the IPv6 attempt fails in
/// microseconds and must not hold IPv4 back for the whole stagger.
pub async fn dial_tcp(host: &str, port: u16) -> Result<TcpStream> {
    let addrs: Vec<SocketAddr> = match host.parse::<std::net::IpAddr>() {
        Ok(ip) => vec![SocketAddr::new(ip, port)],
        Err(_) => tokio::net::lookup_host((host, port))
            .await
            .map_err(|e| Error::unreachable(format!("cannot resolve {host}: {e}")))?
            .collect(),
    };
    if addrs.is_empty() {
        return Err(Error::unreachable(format!("cannot resolve {host}")));
    }
    dial_addrs(host, port, interleave_families(addrs)).await
}

async fn dial_addrs(host: &str, port: u16, addrs: Vec<SocketAddr>) -> Result<TcpStream> {
    let mut pending = addrs.into_iter();
    let mut set = tokio::task::JoinSet::new();
    let mut last_err = None;
    loop {
        if let Some(addr) = pending.next() {
            set.spawn(TcpStream::connect(addr));
        }
        let more = pending.len() > 0;
        let stagger = tokio::time::sleep(STAGGER);
        tokio::pin!(stagger);
        // Wait for a result, or for the stagger when another address is left to start.
        loop {
            tokio::select! {
                res = set.join_next(), if !set.is_empty() => match res {
                    Some(Ok(Ok(s))) => {
                        set.abort_all();
                        let _ = s.set_nodelay(true);
                        return Ok(s);
                    }
                    Some(Ok(Err(e))) => {
                        last_err = Some(e);
                        if more { break; }
                    }
                    _ => {}
                },
                _ = &mut stagger, if more => break,
            }
            if set.is_empty() && !more {
                return Err(Error::unreachable(format!(
                    "cannot connect to {host}:{port}: {}",
                    last_err.map(|e| e.to_string()).unwrap_or_default()
                )));
            }
        }
    }
}

const STAGGER: Duration = Duration::from_millis(250);

fn interleave_families(addrs: Vec<SocketAddr>) -> Vec<SocketAddr> {
    let (v6, v4): (Vec<_>, Vec<_>) = addrs.into_iter().partition(|a| a.is_ipv6());
    let mut out = Vec::with_capacity(v6.len() + v4.len());
    let (mut a, mut b) = (v6.into_iter(), v4.into_iter());
    loop {
        match (a.next(), b.next()) {
            (None, None) => break,
            (x, y) => out.extend(x.into_iter().chain(y)),
        }
    }
    out
}

/// Connects to `target`, through the proxy when one applies, and does the TLS
/// handshake offering `alpn`.
pub async fn connect(target: &Target, alpn: &[&[u8]]) -> Result<Stream> {
    let tcp = match proxy_for(&target.host) {
        Some(proxy) => connect_via_proxy(&proxy, target).await?,
        None => dial_tcp(&target.host, target.port).await?,
    };
    if !target.tls {
        return Ok(Stream::Plain(tcp));
    }
    let config = tls_config(alpn)?;
    let name = rustls::pki_types::ServerName::try_from(target.host.clone())
        .map_err(|_| Error::usage(format!("invalid host name: {}", target.host)))?;
    let tls = TlsConnector::from(config)
        .connect(name, tcp)
        .await
        .map_err(|e| Error::unreachable(format!("TLS handshake with {} failed: {e}", target.host)))?;
    Ok(Stream::Tls(Box::new(tls)))
}

async fn connect_via_proxy(proxy: &str, target: &Target) -> Result<TcpStream> {
    let with_scheme = if proxy.contains("://") { proxy.to_string() } else { format!("http://{proxy}") };
    let (scheme, rest) = with_scheme.split_once("://").unwrap_or(("http", &with_scheme));
    if scheme != "http" {
        return Err(Error::usage(format!("only http:// proxies are supported, not {scheme}://")));
    }
    let authority = rest.split('/').next().unwrap_or(rest);
    let (userinfo, hostport) = match authority.rsplit_once('@') {
        Some((u, h)) => (Some(u), h),
        None => (None, authority),
    };
    let (phost, pport) = split_host_port(hostport, 80)?;
    let mut tcp = dial_tcp(&phost, pport).await?;
    let host = if target.host.contains(':') { format!("[{}]", target.host) } else { target.host.clone() };
    let mut req = format!("CONNECT {host}:{port} HTTP/1.1\r\nHost: {host}:{port}\r\n", port = target.port);
    if let Some(u) = userinfo {
        use base64::Engine;
        let decoded = percent_decode(u);
        req.push_str(&format!(
            "Proxy-Authorization: Basic {}\r\n",
            base64::engine::general_purpose::STANDARD.encode(decoded)
        ));
    }
    req.push_str("\r\n");
    tcp.write_all(req.as_bytes()).await.map_err(|e| Error::unreachable(format!("proxy: {e}")))?;
    let mut buf = Vec::with_capacity(256);
    let mut byte = [0u8; 1];
    // Read the response head byte by byte: nothing after it may be consumed.
    while !buf.ends_with(b"\r\n\r\n") {
        if buf.len() > 8192 {
            return Err(Error::unreachable("proxy: response head too long"));
        }
        let n = tcp.read(&mut byte).await.map_err(|e| Error::unreachable(format!("proxy: {e}")))?;
        if n == 0 {
            return Err(Error::unreachable("proxy closed the connection"));
        }
        buf.push(byte[0]);
    }
    let head = String::from_utf8_lossy(&buf);
    let status = head.split_whitespace().nth(1).unwrap_or("");
    if status != "200" {
        return Err(Error::unreachable(format!("proxy refused CONNECT: {}", head.lines().next().unwrap_or(""))));
    }
    Ok(tcp)
}

fn percent_decode(s: &str) -> Vec<u8> {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len()
            && let Some(v) = std::str::from_utf8(&b[i + 1..i + 3]).ok().and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        out.push(b[i]);
        i += 1;
    }
    out
}

/// Percent-encodes a query value or path segment.
pub fn encode(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        match b {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => out.push(b as char),
            _ => out.push_str(&format!("%{b:02X}")),
        }
    }
    out
}

pub fn query_string(pairs: &[(String, String)]) -> String {
    let mut out = String::new();
    for (k, v) in pairs {
        out.push(if out.is_empty() { '?' } else { '&' });
        out.push_str(&encode(k));
        out.push('=');
        out.push_str(&encode(v));
    }
    out
}

#[cfg(test)]
mod tests {
    #[tokio::test]
    async fn a_failed_attempt_starts_the_next_at_once() {
        let open = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused = closed.local_addr().unwrap();
        drop(closed);
        let t = std::time::Instant::now();
        let s = super::dial_addrs("test", 0, vec![refused, open.local_addr().unwrap()]).await.unwrap();
        assert_eq!(s.peer_addr().unwrap(), open.local_addr().unwrap());
        assert!(t.elapsed() < super::STAGGER, "waited {:?}", t.elapsed());
    }

    #[tokio::test]
    async fn every_address_failing_is_an_error() {
        let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let refused = closed.local_addr().unwrap();
        drop(closed);
        assert!(super::dial_addrs("test", 0, vec![refused, refused]).await.is_err());
    }

    use super::*;

    #[test]
    fn parses_targets() {
        let t = Target::parse("https://app.opencomputer.dev/api/x?y=1").unwrap();
        assert!(t.tls);
        assert_eq!(t.port, 443);
        assert_eq!(t.path, "/api/x?y=1");
        let t = Target::parse("ws://127.0.0.1:9000?attach=cs_1").unwrap();
        assert!(!t.tls);
        assert_eq!((t.host.as_str(), t.port), ("127.0.0.1", 9000));
        assert_eq!(t.path, "/?attach=cs_1");
        let t = Target::parse("http://[::1]:8080/").unwrap();
        assert_eq!(t.host, "::1");
        assert_eq!(t.authority(), "[::1]:8080");
        assert!(Target::parse("https://user:pw@x.dev/").is_err());
    }

    #[test]
    fn encodes_queries() {
        let q = query_string(&[("metadata[job]".into(), "a b&c".into())]);
        assert_eq!(q, "?metadata%5Bjob%5D=a%20b%26c");
    }

    #[test]
    fn decodes_userinfo() {
        assert_eq!(percent_decode("a%40b:c"), b"a@b:c");
    }
}
