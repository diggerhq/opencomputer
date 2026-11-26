//! `opc shell` and `/shell`: a terminal in the session's workspace over a
//! WebSocket of its own (`terminals.open`, binary frames per channel,
//! `terminal.exited`).
//!
//! With a terminal on both ends, the local one goes raw and every byte is
//! forwarded as typed (`Ctrl+C` is `\x03`, `Ctrl+D` is `\x04`); its size
//! follows `SIGWINCH`. Without, standard input is piped through and closed
//! with `terminals.eof`, and standard error comes on its own channel.

use super::{Ctx, resolve};
use crate::cli::ShellArgs;
use crate::error::{Error, Result, exit};
use crate::wire::{WireEvent, WireHandle};
use bytes::Bytes;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::time::{Duration, Instant};
use tokio::sync::{mpsc, watch};

/// Terminal frames carry at most 64 KiB, the channel included.
const MAX_INPUT_CHUNK: usize = 32 * 1024;
/// Input over 1 MiB a second per terminal is dropped by the server.
const INPUT_RATE: usize = 1 << 20;
/// A size is sent once it has held this long, so dragging a window's edge
/// sends one `terminals.resize`, not one per step.
const RESIZE_SETTLE: Duration = Duration::from_millis(50);

pub async fn run(ctx: &Ctx, a: ShellArgs) -> Result<i32> {
    let target = resolve::operand(a.id.as_deref(), a.session.session.as_deref())?;
    let resolved = resolve::session_or_last(ctx, target.as_deref(), true).await?;
    let tty = wants_tty(a.no_tty, ctx.tty.stdin, ctx.tty.stdout);
    open(ctx, &resolved.id, a.command.as_deref(), tty).await
}

/// `/shell` in the TUI: an interactive shell in the session's workspace,
/// with the terminal handed over until it exits. Returns the exit code.
/// The caller must stop reading the terminal (its event stream) first; raw
/// mode is left as it was found.
pub async fn interactive(ctx: &Ctx, session_id: &str) -> Result<i32> {
    open(ctx, session_id, None, true).await
}

/// A remote terminal only when ours is one on both ends, as `ssh` does.
fn wants_tty(no_tty: bool, stdin: bool, stdout: bool) -> bool {
    !no_tty && stdin && stdout
}

/// The parameters of `terminals.open`.
fn open_params(session_id: &str, command: Option<&str>, size: Option<(u16, u16)>, term: Option<String>) -> Value {
    let mut p = json!({ "sessionId": session_id, "tty": size.is_some() });
    if let Some((cols, rows)) = size {
        p["cols"] = json!(cols);
        p["rows"] = json!(rows);
        p["term"] = json!(term.filter(|t| !t.is_empty()).unwrap_or_else(|| "xterm-256color".into()));
    }
    if let Some(c) = command {
        p["command"] = json!(c);
    }
    p
}

/// The shell's exit status as a process exit code: the code, or 128 plus the
/// signal's number.
fn exit_code(v: &Value) -> i32 {
    if let Some(c) = v.get("exitCode").and_then(Value::as_i64) {
        return c as i32;
    }
    let n = match v.get("signal") {
        Some(Value::Number(n)) => n.as_i64(),
        Some(Value::String(s)) => match s.trim_start_matches("SIG") {
            "HUP" => Some(1),
            "INT" => Some(2),
            "QUIT" => Some(3),
            "ABRT" => Some(6),
            "KILL" => Some(9),
            "SEGV" => Some(11),
            "PIPE" => Some(13),
            "TERM" => Some(15),
            other => other.parse().ok(),
        },
        _ => None,
    };
    n.map_or(1, |n| 128 + n as i32)
}

fn open_error(e: Error) -> Error {
    let reason = e.extra.get("reason").and_then(Value::as_str).unwrap_or("");
    match (e.code.as_str(), reason) {
        ("forbidden", "terminal_owner_only") => Error { message: "only the owner of this session can open a shell in it".into(), ..e },
        ("forbidden", "missing_scope") => Error { message: "this API key cannot open shells: it needs the terminals scope".into(), ..e },
        ("feature_unavailable", _) => Error { message: "shells are not available on this computer".into(), ..e },
        ("too_many_terminals", _) => Error { message: "8 shells are already open in this session: close one first".into(), ..e },
        _ => e,
    }
}

/// Raw mode while the shell runs, restored on every way out.
struct RawMode {
    was_raw: bool,
    on: bool,
}

impl RawMode {
    fn enter(on: bool) -> Result<RawMode> {
        if !on {
            return Ok(RawMode { was_raw: false, on: false });
        }
        let was_raw = crossterm::terminal::is_raw_mode_enabled().unwrap_or(false);
        if !was_raw {
            crossterm::terminal::enable_raw_mode().map_err(|e| Error::new("io", format!("cannot set up the terminal: {e}")))?;
        }
        Ok(RawMode { was_raw, on: true })
    }
}

impl Drop for RawMode {
    fn drop(&mut self) {
        if self.on && !self.was_raw {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }
}

enum Input {
    Data(Bytes),
    Eof,
}

/// Pipes and files: a thread (a blocked read never holds up the exit),
/// paced to the server's input rate.
fn spawn_pipe_reader(tx: mpsc::Sender<Input>) {
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin();
        let mut buf = vec![0u8; MAX_INPUT_CHUNK];
        let mut window = Instant::now();
        let mut sent = 0usize;
        loop {
            match stdin.read(&mut buf) {
                Ok(0) => {
                    let _ = tx.blocking_send(Input::Eof);
                    return;
                }
                Ok(n) => {
                    if window.elapsed() >= Duration::from_secs(1) {
                        window = Instant::now();
                        sent = 0;
                    }
                    if sent + n > INPUT_RATE {
                        std::thread::sleep(Duration::from_secs(1).saturating_sub(window.elapsed()));
                        window = Instant::now();
                        sent = 0;
                    }
                    sent += n;
                    if tx.blocking_send(Input::Data(Bytes::copy_from_slice(&buf[..n]))).is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => {
                    let _ = tx.blocking_send(Input::Eof);
                    return;
                }
            }
        }
    });
}

/// A terminal: read when the reactor says it is readable, so the reader can
/// be stopped when the shell ends and never eats the keystrokes that follow
/// (the TUI reads them next).
#[cfg(unix)]
fn spawn_tty_reader(tx: mpsc::Sender<Input>) -> Option<tokio::task::JoinHandle<()>> {
    use tokio::io::unix::AsyncFd;
    // SAFETY: standard input's descriptor stays open, and is the same
    // descriptor, for the life of the process.
    let afd = unsafe { AsyncFd::register_with_interest(std::io::stdin(), tokio::io::Interest::READABLE) }.ok()?;
    Some(tokio::spawn(async move {
        // Larger than stdin's buffer, so reads go straight to the terminal.
        let mut buf = vec![0u8; 16 * 1024];
        loop {
            let Ok(mut guard) = afd.readable().await else { return };
            match std::io::stdin().read(&mut buf) {
                Ok(0) => {
                    let _ = tx.send(Input::Eof).await;
                    return;
                }
                Ok(n) => {
                    if n < buf.len() {
                        guard.clear_ready();
                    }
                    if tx.send(Input::Data(Bytes::copy_from_slice(&buf[..n]))).await.is_err() {
                        return;
                    }
                }
                Err(e) if e.kind() == std::io::ErrorKind::Interrupted => {}
                Err(_) => return,
            }
        }
    }))
}

#[cfg(not(unix))]
fn spawn_tty_reader(_tx: mpsc::Sender<Input>) -> Option<tokio::task::JoinHandle<()>> {
    None
}

/// Stops the stdin reader task when the shell ends.
struct Abort(Option<tokio::task::JoinHandle<()>>);

impl Drop for Abort {
    fn drop(&mut self) {
        if let Some(t) = self.0.take() {
            t.abort();
        }
    }
}

/// Window size changes, where there are signals for them.
struct Resizes {
    #[cfg(unix)]
    sig: Option<tokio::signal::unix::Signal>,
}

impl Resizes {
    fn new(on: bool) -> Resizes {
        #[cfg(unix)]
        {
            let sig = if on { tokio::signal::unix::signal(tokio::signal::unix::SignalKind::window_change()).ok() } else { None };
            Resizes { sig }
        }
        #[cfg(not(unix))]
        {
            let _ = on;
            Resizes {}
        }
    }

    async fn next(&mut self) {
        #[cfg(unix)]
        if let Some(s) = self.sig.as_mut() {
            s.recv().await;
            return;
        }
        std::future::pending::<()>().await
    }
}

/// Sends each size the terminal settles at ([`RESIZE_SETTLE`]) and that
/// differs from the last one sent (at first, `opened`), one request at a
/// time, so the shell ends at the last size and not at whichever request
/// landed last.
async fn send_resizes<F, Fut>(mut sizes: watch::Receiver<(u16, u16)>, opened: (u16, u16), mut send: F)
where
    F: FnMut((u16, u16)) -> Fut,
    Fut: Future<Output = ()>,
{
    let mut sent = opened;
    while sizes.changed().await.is_ok() {
        loop {
            match tokio::time::timeout(RESIZE_SETTLE, sizes.changed()).await {
                Ok(Ok(())) => {}
                Ok(Err(_)) => return,
                Err(_) => break,
            }
        }
        let size = *sizes.borrow_and_update();
        if size != sent {
            send(size).await;
            sent = size;
        }
    }
}

fn write_all(mut w: impl Write, data: &[u8]) -> std::io::Result<()> {
    w.write_all(data)?;
    w.flush()
}

async fn open(ctx: &Ctx, session_id: &str, command: Option<&str>, tty: bool) -> Result<i32> {
    let (wire, mut events) = ctx.open_wire(vec![], false).await?;
    let result = session(&wire, &mut events, session_id, command, tty).await;
    wire.close();
    result
}

async fn session(
    wire: &WireHandle,
    events: &mut mpsc::UnboundedReceiver<WireEvent>,
    session_id: &str,
    command: Option<&str>,
    tty: bool,
) -> Result<i32> {
    let size = tty.then(|| crossterm::terminal::size().unwrap_or((80, 24)));
    let params = open_params(session_id, command, size, std::env::var("TERM").ok());

    // Output can arrive before the result: hold it until we know our channel.
    let mut early: Vec<WireEvent> = Vec::new();
    let call = wire.call("terminals.open", params);
    tokio::pin!(call);
    let opened = loop {
        tokio::select! {
            r = &mut call => break r.map_err(open_error)?,
            ev = events.recv() => match ev {
                Some(WireEvent::Fatal(e)) => return Err(e),
                None => return Err(Error::unreachable("the connection to your computer closed")),
                Some(e @ (WireEvent::Binary { .. } | WireEvent::TerminalExited(_))) => early.push(e),
                Some(_) => {}
            },
        }
    };
    let t = opened.get("terminal").unwrap_or(&opened);
    let terminal_id = t.get("id").and_then(Value::as_str).unwrap_or_default().to_string();
    let channel = t.get("channel").and_then(Value::as_u64).ok_or_else(|| Error::new("invalid_response", "terminals.open returned no channel"))? as u32;
    let stderr_channel = t.get("stderrChannel").and_then(Value::as_u64).map(|c| c as u32);
    crate::log::debug(&format!("shell: {terminal_id} on channel {channel}{}", stderr_channel.map(|c| format!(", stderr {c}")).unwrap_or_default()));

    let _raw = RawMode::enter(tty)?;
    let (in_tx, mut in_rx) = mpsc::channel::<Input>(16);
    let reader = if tty { spawn_tty_reader(in_tx.clone()) } else { None };
    if reader.is_none() {
        spawn_pipe_reader(in_tx);
    } else {
        drop(in_tx);
    }
    let _reader = Abort(reader);
    let mut resizes = Resizes::new(tty);
    let opened = size.unwrap_or((80, 24));
    let (size_tx, size_rx) = watch::channel(opened);
    let _resizer = Abort(tty.then(|| {
        let w = wire.clone();
        let id = terminal_id.clone();
        tokio::spawn(send_resizes(size_rx, opened, move |(cols, rows)| {
            let w = w.clone();
            let id = id.clone();
            async move {
                let _ = w.call("terminals.resize", json!({ "terminalId": id, "cols": cols, "rows": rows })).await;
            }
        }))
    }));
    let mut input_open = true;
    let close = |wire: &WireHandle| {
        let w = wire.clone();
        let id = terminal_id.clone();
        tokio::spawn(async move {
            let _ = w.call("terminals.close", json!({ "terminalId": id })).await;
        });
    };

    // Without a terminal, Ctrl+C here hangs up the remote command. With
    // one, it is a byte like any other.
    let sigint = async {
        if tty {
            std::future::pending::<()>().await
        } else {
            let _ = tokio::signal::ctrl_c().await;
        }
    };
    tokio::pin!(sigint);
    let mut pending = early.into_iter();
    loop {
        let ev = match pending.next() {
            Some(e) => Some(e),
            None => tokio::select! {
                ev = events.recv() => ev,
                input = in_rx.recv(), if input_open => {
                    match input {
                        Some(Input::Data(data)) => wire.send_binary(channel, data),
                        Some(Input::Eof) | None => {
                            input_open = false;
                            if !tty {
                                let w = wire.clone();
                                let id = terminal_id.clone();
                                tokio::spawn(async move {
                                    let _ = w.call("terminals.eof", json!({ "terminalId": id })).await;
                                });
                            }
                        }
                    }
                    continue;
                }
                _ = resizes.next() => {
                    if let Ok(size) = crossterm::terminal::size() {
                        size_tx.send_replace(size);
                    }
                    continue;
                }
                _ = &mut sigint => {
                    close(wire);
                    return Ok(exit::INTERRUPTED);
                }
            },
        };
        match ev {
            Some(WireEvent::Binary { channel: c, data }) => {
                let written = if c == channel {
                    write_all(std::io::stdout().lock(), &data)
                } else if Some(c) == stderr_channel {
                    write_all(std::io::stderr().lock(), &data)
                } else {
                    Ok(())
                };
                if written.is_err() {
                    // Our output is gone (`| head`): hang up, quietly.
                    close(wire);
                    return Ok(exit::OK);
                }
            }
            Some(WireEvent::TerminalExited(v)) => {
                if v.get("terminalId").and_then(Value::as_str).is_none_or(|id| id == terminal_id) {
                    return Ok(exit_code(&v));
                }
            }
            // A terminal does not survive a reconnect: the shell is gone.
            Some(WireEvent::Reconnecting { .. }) => {
                return Err(Error::unreachable("the connection to your computer dropped, and the shell with it"));
            }
            Some(WireEvent::Fatal(e)) => return Err(e),
            None => return Err(Error::unreachable("the connection to your computer closed")),
            Some(_) => {}
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tty_only_with_terminals_on_both_ends() {
        assert!(wants_tty(false, true, true));
        assert!(!wants_tty(true, true, true));
        assert!(!wants_tty(false, false, true));
        assert!(!wants_tty(false, true, false));
    }

    #[test]
    fn open_params_follow_the_docs() {
        let p = open_params("cs_x", None, Some((120, 40)), Some("screen".into()));
        assert_eq!(p, json!({"sessionId": "cs_x", "tty": true, "cols": 120, "rows": 40, "term": "screen"}));
        let p = open_params("cs_x", Some("ls"), Some((80, 24)), None);
        assert_eq!(p["term"], "xterm-256color");
        assert_eq!(p["command"], "ls");
        let p = open_params("cs_x", Some("tar -c q3"), None, Some("xterm".into()));
        assert_eq!(p, json!({"sessionId": "cs_x", "tty": false, "command": "tar -c q3"}));
    }

    /// Sizes sent to the fake `terminals.resize`, at paused (fake) time.
    async fn resizes_for(steps: &[(u64, (u16, u16))]) -> Vec<(u16, u16)> {
        let (tx, rx) = watch::channel((80, 24));
        let (out_tx, mut out) = mpsc::unbounded_channel();
        let task = tokio::spawn(send_resizes(rx, (80, 24), move |size| {
            let out_tx = out_tx.clone();
            async move {
                let _ = out_tx.send(size);
                // A slow server: later sizes wait for this answer.
                tokio::time::sleep(Duration::from_millis(200)).await;
            }
        }));
        for (after_ms, size) in steps {
            tokio::time::sleep(Duration::from_millis(*after_ms)).await;
            tx.send_replace(*size);
        }
        tokio::time::sleep(Duration::from_secs(5)).await;
        drop(tx);
        task.await.unwrap();
        let mut got = Vec::new();
        while let Ok(s) = out.try_recv() {
            got.push(s);
        }
        got
    }

    #[tokio::test(start_paused = true)]
    async fn resizes_coalesce_to_the_settled_size() {
        // A drag: a step every 10 ms, then still.
        let drag: Vec<(u64, (u16, u16))> = (0..40).map(|i| (10, (81 + i, 24))).collect();
        assert_eq!(resizes_for(&drag).await, vec![(120, 24)]);
        // Two drags apart: two sends. Back to the size last sent: none.
        assert_eq!(resizes_for(&[(0, (100, 30)), (500, (90, 20))]).await, vec![(100, 30), (90, 20)]);
        assert_eq!(resizes_for(&[(0, (100, 30)), (10, (80, 24))]).await, Vec::<(u16, u16)>::new());
        // Sizes that settle while a resize is in flight: the last one follows it.
        assert_eq!(resizes_for(&[(0, (100, 30)), (100, (110, 30)), (60, (120, 30))]).await, vec![(100, 30), (120, 30)]);
    }

    #[test]
    fn exit_codes() {
        assert_eq!(exit_code(&json!({"exitCode": 0, "signal": null})), 0);
        assert_eq!(exit_code(&json!({"exitCode": 3, "signal": null})), 3);
        assert_eq!(exit_code(&json!({"exitCode": null, "signal": "SIGKILL"})), 137);
        assert_eq!(exit_code(&json!({"exitCode": null, "signal": 15})), 143);
        assert_eq!(exit_code(&json!({"exitCode": null, "signal": null})), 1);
    }

    #[test]
    fn owner_only_is_exit_3_with_the_docs_message() {
        let e = open_error(Error::from_api(403, &json!({"code": "forbidden", "message": "m", "reason": "terminal_owner_only"})));
        assert_eq!(e.message, "only the owner of this session can open a shell in it");
        assert_eq!(e.exit_code(), 3);
    }

    #[test]
    fn session_operand_rules() {
        assert_eq!(resolve::operand(Some("7f3a"), None).unwrap().as_deref(), Some("7f3a"));
        assert_eq!(resolve::operand(None, Some("7f3a")).unwrap().as_deref(), Some("7f3a"));
        assert_eq!(resolve::operand(Some("a"), Some("b")).unwrap_err().code, "usage");
    }
}
