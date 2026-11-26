//! What `opc push` and `opc pull` share: limits, the pipes between a
//! blocking tar/zstd task and a hyper body, path checks and formatting.

use bytes::Bytes;
use std::io::{self, Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::mpsc;

/// 1 GiB and 100,000 files per push or pull, unpacked.
pub const MAX_BYTES: u64 = 1 << 30;
pub const MAX_FILES: u64 = 100_000;

/// Chunks between the tar task and the network.
const CHUNK: usize = 256 * 1024;

/// What went across, updated by the blocking side and read by the meter.
#[derive(Debug, Default)]
pub struct Counters {
    pub files: AtomicU64,
    pub bytes: AtomicU64,
}

impl Counters {
    pub fn add(&self, files: u64, bytes: u64) {
        self.files.fetch_add(files, Ordering::Relaxed);
        self.bytes.fetch_add(bytes, Ordering::Relaxed);
    }
    pub fn get(&self) -> (u64, u64) {
        (self.files.load(Ordering::Relaxed), self.bytes.load(Ordering::Relaxed))
    }
}

/// A `Write` for a blocking task that feeds an async body, in chunks.
pub struct ChannelWriter {
    tx: mpsc::Sender<io::Result<Bytes>>,
    buf: Vec<u8>,
}

impl ChannelWriter {
    pub fn new(tx: mpsc::Sender<io::Result<Bytes>>) -> Self {
        ChannelWriter { tx, buf: Vec::with_capacity(CHUNK) }
    }

    fn send(&mut self) -> io::Result<()> {
        if self.buf.is_empty() {
            return Ok(());
        }
        let chunk = Bytes::from(std::mem::replace(&mut self.buf, Vec::with_capacity(CHUNK)));
        self.tx
            .blocking_send(Ok(chunk))
            .map_err(|_| io::Error::new(io::ErrorKind::BrokenPipe, "the upload stopped"))
    }

    /// Ends the body with an error, so the server never sees a whole archive.
    pub fn abort(self, e: &io::Error) {
        let _ = self.tx.blocking_send(Err(io::Error::new(e.kind(), e.to_string())));
    }
}

impl Write for ChannelWriter {
    fn write(&mut self, data: &[u8]) -> io::Result<usize> {
        self.buf.extend_from_slice(data);
        if self.buf.len() >= CHUNK {
            self.send()?;
        }
        Ok(data.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        self.send()
    }
}

/// A body made of what a [`ChannelWriter`] sends.
pub fn channel_body(rx: mpsc::Receiver<io::Result<Bytes>>) -> crate::http::Body {
    use http_body_util::BodyExt;
    let stream = futures_util::stream::unfold(rx, |mut rx| async move {
        rx.recv().await.map(|item| (item.map(hyper::body::Frame::data), rx))
    });
    http_body_util::StreamBody::new(stream).boxed()
}

/// A blocking `Read` over chunks an async task forwards from a response body.
pub struct ChannelReader {
    rx: mpsc::Receiver<io::Result<Bytes>>,
    cur: Bytes,
    done: bool,
}

impl ChannelReader {
    pub fn new(rx: mpsc::Receiver<io::Result<Bytes>>) -> Self {
        ChannelReader { rx, cur: Bytes::new(), done: false }
    }
}

impl Read for ChannelReader {
    fn read(&mut self, out: &mut [u8]) -> io::Result<usize> {
        while self.cur.is_empty() {
            if self.done {
                return Ok(0);
            }
            match self.rx.blocking_recv() {
                Some(Ok(b)) => self.cur = b,
                Some(Err(e)) => return Err(e),
                None => {
                    self.done = true;
                    return Ok(0);
                }
            }
        }
        let n = out.len().min(self.cur.len());
        out[..n].copy_from_slice(&self.cur[..n]);
        let _ = self.cur.split_to(n);
        Ok(n)
    }
}

/// Forwards a response body into a [`ChannelReader`]'s channel.
pub async fn forward_body(mut body: hyper::body::Incoming, tx: mpsc::Sender<io::Result<Bytes>>) {
    use http_body_util::BodyExt;
    loop {
        match body.frame().await {
            Some(Ok(frame)) => {
                if let Ok(data) = frame.into_data()
                    && tx.send(Ok(data)).await.is_err()
                {
                    return;
                }
            }
            Some(Err(e)) => {
                let _ = tx.send(Err(io::Error::other(format!("the download broke off: {e}")))).await;
                return;
            }
            None => return,
        }
    }
}

/// A path from an archive or the command line as a safe relative path:
/// no root, no drive, no `..`. `.` components are dropped; empty means the
/// root itself.
pub fn safe_relative(p: &str) -> Result<PathBuf, String> {
    if p.starts_with('/') || p.starts_with('\\') {
        return Err(format!("{p} is an absolute path"));
    }
    let mut out = PathBuf::new();
    for c in Path::new(p).components() {
        match c {
            Component::Normal(s) => {
                if s.to_string_lossy().contains('\\') && cfg!(windows) {
                    return Err(format!("{p} has a backslash"));
                }
                out.push(s)
            }
            Component::CurDir => {}
            Component::ParentDir => return Err(format!("{p} goes up with ..")),
            Component::RootDir | Component::Prefix(_) => return Err(format!("{p} is an absolute path")),
        }
    }
    Ok(out)
}

/// Whether a symbolic link at `link` (relative to the root) pointing at
/// `target` stays inside the root.
pub fn link_stays_inside(link: &Path, target: &Path) -> bool {
    if target.has_root() || target.components().any(|c| matches!(c, Component::Prefix(_))) {
        return false;
    }
    // Depth of the directory that holds the link.
    let mut depth: i64 = link.parent().map_or(0, |p| p.components().filter(|c| matches!(c, Component::Normal(_))).count() as i64);
    for c in target.components() {
        match c {
            Component::Normal(_) => depth += 1,
            Component::ParentDir => {
                depth -= 1;
                if depth < 0 {
                    return false;
                }
            }
            _ => {}
        }
    }
    true
}

/// An upload name: one level, letters, digits, `.`, `-`, `_`, not starting
/// with `.`.
pub fn valid_upload_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 255
        && !name.starts_with('.')
        && name.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'-' | b'_'))
}

/// `3.1 MB`, decimal units as `du -h --si` prints them.
pub fn human_bytes(n: u64) -> String {
    const UNITS: [&str; 5] = ["B", "KB", "MB", "GB", "TB"];
    if n < 1000 {
        return format!("{n} B");
    }
    let mut v = n as f64;
    let mut i = 0;
    while v >= 1000.0 && i < UNITS.len() - 1 {
        v /= 1000.0;
        i += 1;
    }
    if v < 10.0 { format!("{v:.1} {}", UNITS[i]) } else { format!("{v:.0} {}", UNITS[i]) }
}

/// `0.9 s`
pub fn human_secs(d: Duration) -> String {
    format!("{:.1} s", d.as_secs_f64())
}

/// `1 file`, `412 files`
pub fn files(n: u64) -> String {
    if n == 1 { "1 file".into() } else { format!("{n} files") }
}

/// `14m ago` from an RFC 3339 time; `None` when it cannot be read.
pub fn ago(rfc3339: &str) -> Option<String> {
    let t = time::OffsetDateTime::parse(rfc3339, &time::format_description::well_known::Rfc3339).ok()?;
    let secs = (time::OffsetDateTime::now_utc() - t).whole_seconds().max(0);
    Some(match secs {
        s if s < 60 => "just now".into(),
        s if s < 3600 => format!("{}m ago", s / 60),
        s if s < 86_400 => format!("{}h ago", s / 3600),
        s => format!("{}d ago", s / 86_400),
    })
}

/// A one-line meter on stderr, redrawn every 100 ms until dropped.
pub struct Meter {
    task: Option<tokio::task::JoinHandle<()>>,
}

impl Meter {
    pub fn start(on: bool, arrow: &'static str, label: String, counters: Arc<Counters>) -> Meter {
        if !on {
            return Meter { task: None };
        }
        let task = tokio::spawn(async move {
            let mut tick = tokio::time::interval(Duration::from_millis(100));
            tick.tick().await;
            loop {
                tick.tick().await;
                let (f, b) = counters.get();
                eprint!("\r\x1b[2K{arrow} {label} · {} · {}", files(f), human_bytes(b));
                let _ = io::stderr().flush();
            }
        });
        Meter { task: Some(task) }
    }
}

impl Drop for Meter {
    fn drop(&mut self) {
        if let Some(t) = self.task.take() {
            t.abort();
            eprint!("\r\x1b[2K");
            let _ = io::stderr().flush();
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn relative_paths() {
        assert_eq!(safe_relative("a/b").unwrap(), PathBuf::from("a/b"));
        assert_eq!(safe_relative("./a/./b/").unwrap(), PathBuf::from("a/b"));
        assert_eq!(safe_relative(".").unwrap(), PathBuf::new());
        assert!(safe_relative("/etc/passwd").is_err());
        assert!(safe_relative("a/../../b").is_err());
        assert!(safe_relative("..").is_err());
        assert!(safe_relative("a/..").is_err());
    }

    #[test]
    fn links_stay_inside() {
        assert!(link_stays_inside(Path::new("a/l"), Path::new("b")));
        assert!(link_stays_inside(Path::new("a/l"), Path::new("../b")));
        assert!(link_stays_inside(Path::new("a/b/l"), Path::new("../../c")));
        assert!(!link_stays_inside(Path::new("l"), Path::new("../x")));
        assert!(!link_stays_inside(Path::new("a/l"), Path::new("../../x")));
        assert!(!link_stays_inside(Path::new("a/l"), Path::new("/etc")));
        assert!(!link_stays_inside(Path::new("a/l"), Path::new("b/../../../x")));
    }

    #[test]
    fn upload_names() {
        for ok in ["billing", "billing-wip", "a.b_c", "X1"] {
            assert!(valid_upload_name(ok), "{ok}");
        }
        for bad in ["", ".hidden", "a/b", "..", "with space", "ü"] {
            assert!(!valid_upload_name(bad), "{bad}");
        }
    }

    #[test]
    fn formats() {
        assert_eq!(human_bytes(999), "999 B");
        assert_eq!(human_bytes(3_245_112), "3.2 MB");
        assert_eq!(human_bytes(280_000), "280 KB");
        assert_eq!(files(1), "1 file");
        assert_eq!(human_secs(Duration::from_millis(900)), "0.9 s");
    }

    #[test]
    fn channel_reader_reassembles() {
        let (tx, rx) = mpsc::channel(4);
        tx.try_send(Ok(Bytes::from_static(b"hel"))).unwrap();
        tx.try_send(Ok(Bytes::from_static(b"lo"))).unwrap();
        drop(tx);
        let mut s = String::new();
        ChannelReader::new(rx).read_to_string(&mut s).unwrap();
        assert_eq!(s, "hello");
    }
}
