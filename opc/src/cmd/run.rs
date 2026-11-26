//! `opc [message]` and `opc -p`: one turn, non-interactively, or the
//! interactive screen. Also the pieces `new`, `send` and `wait` share:
//! creating, sending, following to a Result and stopping early.

use super::follow::{self, Follower, Goal, Step, Tracker};
use super::{Ctx, print_json, print_line, println_out};
use crate::api::result;
use crate::api::types::{Created, Sent, Turn};
use crate::cache;
use crate::cli::{Format, LoginArgs, NewSession, OnAsk, RunArgs};
use crate::error::{Error, Result, exit};
use crate::http::session_path;
use crate::ids;
use crate::render;
use crate::wire::Attach;
use serde_json::{Map, Value, json};
use std::time::{Duration, Instant};

/// `opc [options] [message]`.
pub async fn root(ctx: &mut Ctx, args: RunArgs, words: Vec<String>) -> Result<i32> {
    let interactive = !args.print && ctx.tty.interactive();
    if interactive {
        let message = super::message_from(&words, false, ctx.tty)?;
        if !ctx.http.has_key() {
            super::auth::login(ctx, LoginArgs { no_browser: false, force: false }).await?;
            ctx.reload()?;
        }
        return super::attach::run_new(ctx, args, message).await;
    }
    let message = super::message_from(&words, true, ctx.tty)?
        .ok_or_else(|| Error::usage("no message: pass one as an argument, or on standard input"))?;
    super::check_message(&message)?;
    print(ctx, args, message).await
}

/// The body of `POST /sessions` from the new-session options.
pub fn create_body(id: &str, new: &NewSession, input: Option<&str>) -> Value {
    let mut b = Map::new();
    b.insert("id".into(), json!(id));
    if let Some(i) = input {
        b.insert("input".into(), json!(i));
    }
    for (k, v) in [("title", &new.title), ("model", &new.model), ("effort", &new.effort), ("speed", &new.speed), ("mode", &new.mode)] {
        if let Some(v) = v {
            b.insert(k.into(), json!(v));
        }
    }
    if !new.metadata.is_empty() {
        let m: Map<String, Value> = new.metadata.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        b.insert("metadata".into(), Value::Object(m));
    }
    Value::Object(b)
}

/// The idempotency key for one request: the derived key when the person gave
/// one, else a fresh one (so the client's own retries are safe).
/// The id for a new session: derived from the idempotency key when there is
/// one, so a repeat is the same request; random otherwise.
pub fn new_session_id(ctx: &Ctx, new: &NewSession) -> Result<String> {
    Ok(match &new.idempotency_key {
        Some(k) => ids::session_id_for_key(ctx.require_key()?, k),
        None => ids::mint_session_id(),
    })
}

pub fn derived_key(base: Option<&str>, suffix: &str) -> String {
    match base {
        Some(k) => format!("{k}:{suffix}"),
        None => ids::idempotency_key(),
    }
}

/// Settings for an existing session are refused rather than ignored.
pub fn reject_new_session_options(new: &NewSession) -> Result<()> {
    let given = [
        (new.model.is_some(), "--model"),
        (new.effort.is_some(), "--effort"),
        (new.speed.is_some(), "--speed"),
        (new.mode.is_some(), "--mode"),
        (new.title.is_some(), "--title"),
        (!new.metadata.is_empty(), "--metadata"),
        (!new.push.is_empty(), "--push"),
    ];
    if let Some((_, name)) = given.iter().find(|(g, _)| *g) {
        return Err(Error::usage(format!("{name} is for a new session; with -s, change settings in the session (/model, /speed, /mode) or use opc push")));
    }
    Ok(())
}

/// Creates a session: with the message in the same request, or, with
/// `--push`, without it, then the uploads, then the message.
pub async fn create(ctx: &Ctx, id: &str, new: &NewSession, input: Option<&str>) -> Result<(Created, Option<Sent>)> {
    let key = new.idempotency_key.as_deref();
    let started = Instant::now();
    let with_input = if new.push.is_empty() { input } else { None };
    let body = create_body(id, new, with_input);
    let got = ctx.http.post("/sessions", &body, Some(&derived_key(key, "create"))).await?;
    crate::timing::get().mark_create(started.elapsed());
    let created: Created = serde_json::from_value(got).map_err(|e| Error::new("internal", format!("the API returned a session opc cannot read: {e}")))?;
    let sid = created.session.id.clone();
    if new.push.is_empty() {
        return Ok((created, None));
    }
    // Uploads can take minutes: say where the session is now, so a caller
    // killed meanwhile can get back to it. The full handle follows the send.
    cache::set_last_session(&sid);
    eprintln!("opc: session {sid} {}", ctx.config.dashboard_url(&sid));
    for (n, dir) in new.push.iter().enumerate() {
        ctx.progress(&format!("pushing {}", dir.display()));
        let upload_key = key.map(|k| format!("{k}:upload:{}", n + 1));
        super::push::push_dir(ctx, &sid, dir, None, upload_key).await?;
    }
    let sent = match input {
        Some(i) => Some(send(ctx, &sid, i, "queue", Some(&derived_key(key, "send"))).await?),
        None => None,
    };
    Ok((created, sent))
}

/// `POST /sessions/{id}/turns`.
pub async fn send(ctx: &Ctx, session_id: &str, input: &str, if_busy: &str, key: Option<&str>) -> Result<Sent> {
    let body = json!({"input": input, "ifBusy": if_busy});
    let got = ctx.http.post(&session_path(session_id, "/turns"), &body, key).await?;
    serde_json::from_value(got).map_err(|e| Error::new("internal", format!("the API returned a turn opc cannot read: {e}")))
}

/// Remembers a session and turn for `-` and `opc wait tn_…`.
pub fn remember(session_id: &str, turn_id: Option<&str>) {
    cache::set_last_session(session_id);
    if let Some(t) = turn_id {
        cache::remember_turn(t, session_id);
    }
}

/// Why waiting stopped before the goal.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Stop {
    Timeout,
    Interrupted,
}

/// Runs `fut` until it ends, `--timeout` passes, or `Ctrl+C`/`SIGTERM`.
pub async fn race<T>(timeout: Option<Duration>, fut: impl std::future::Future<Output = Result<T>>) -> Result<std::result::Result<T, Stop>> {
    let sleep = async {
        match timeout {
            Some(d) => tokio::time::sleep(d).await,
            None => std::future::pending().await,
        }
    };
    tokio::select! {
        r = fut => r.map(Ok),
        _ = sleep => Ok(Err(Stop::Timeout)),
        _ = signal() => Ok(Err(Stop::Interrupted)),
    }
}

async fn signal() {
    #[cfg(unix)]
    {
        use tokio::signal::unix::{SignalKind, signal};
        let mut term = match signal(SignalKind::terminate()) {
            Ok(s) => s,
            Err(_) => {
                let _ = tokio::signal::ctrl_c().await;
                return;
            }
        };
        tokio::select! {
            _ = tokio::signal::ctrl_c() => {}
            _ = term.recv() => {}
        }
    }
    #[cfg(not(unix))]
    {
        let _ = tokio::signal::ctrl_c().await;
    }
}

/// The error for stopping early, after interrupting the turn when asked.
pub async fn stopped(f: &Follower, session_id: &str, turn_id: Option<&str>, stop: Stop, interrupt: bool) -> Error {
    let mut interrupted = false;
    if interrupt {
        let mut p = json!({"sessionId": session_id, "idempotencyKey": ids::idempotency_key()});
        if let Some(t) = turn_id {
            p["turnId"] = json!(t);
        }
        let call = f.wire.call("sessions.interrupt", p);
        interrupted = matches!(tokio::time::timeout(Duration::from_secs(5), call).await, Ok(Ok(_)));
    }
    let tail = if interrupted { "interrupted the turn".to_string() } else { format!("still running: opc a {session_id}") };
    let e = match stop {
        Stop::Timeout => Error::new("timeout", format!("timed out; {tail}")),
        Stop::Interrupted => Error::new("interrupted", tail),
    };
    e.with("sessionId", session_id)
}

/// What `-p`, `send --wait`, `wait` and `watch` print while they follow.
pub struct Printer {
    pub format: Format,
    pub partial: bool,
    /// Progress lines on standard error (a terminal, not `-q`).
    pub progress: bool,
    /// Only these sessions' events.
    pub sessions: Vec<String>,
}

impl Printer {
    pub fn sink(&self) -> impl FnMut(&Follower, &Step) + Send + use<> {
        let format = self.format;
        let partial = self.partial;
        let progress = self.progress;
        let sessions = self.sessions.clone();
        move |_f: &Follower, step: &Step| match step {
            Step::Event(e) if sessions.iter().any(|s| s == e.session_id()) => match format {
                Format::StreamJson => print_line(&e.0),
                Format::Text if progress => {
                    if let Some(l) = render::progress_line(e) {
                        eprintln!("opc: {l}");
                    }
                }
                _ => {}
            },
            Step::Delta(d) if format == Format::StreamJson && partial && d.partial() => print_line(&d.0),
            Step::Reconnecting { attempt, retry_in, .. } if progress && follow::worth_saying(*attempt, *retry_in) => eprintln!("opc: connection lost, reconnecting in {}", render::duration(retry_in.as_millis() as u64)),
            Step::Detached(sid, reason) => eprintln!("opc: stopped receiving {sid}: {reason}"),
            _ => {}
        }
    }
}

/// Prints a Result in the chosen format and returns its exit code.
pub fn finish(ctx: &Ctx, r: Option<&Value>, format: Format) -> i32 {
    // A session that has never run a turn: nothing to report.
    let Some(r) = r else { return exit::OK };
    match format {
        Format::Json => print_json(ctx, r),
        Format::StreamJson => print_line(r),
        Format::Text => {
            if r.get("status").and_then(Value::as_str) == Some("completed") {
                let text = result::text(r);
                if !text.is_empty() {
                    println_out(&text);
                }
            }
        }
    }
    if let Some(msg) = result::describe_failure(r) {
        eprintln!("opc: {msg}");
    }
    let running = r.get("subagents").and_then(Value::as_array).map(|a| a.iter().filter(|s| s["status"] == "running").count()).unwrap_or(0);
    if running > 0 {
        let sid = r.get("sessionId").and_then(Value::as_str).unwrap_or("");
        ctx.progress(&format!("{running} background subagent{} still running: opc subagents -s {sid}", if running == 1 { "" } else { "s" }));
    }
    result::exit_code(r)
}

/// Follows one turn to its Result and prints it.
#[allow(clippy::too_many_arguments)]
pub async fn follow_turn(
    ctx: &Ctx,
    f: &mut Follower,
    mut tracker: Tracker,
    printer: &Printer,
    url: &str,
    timeout: Option<Duration>,
    interrupt_on_timeout: bool,
    interrupt_on_exit: bool,
) -> Result<i32> {
    let sid = tracker.session_id.clone();
    let mut sink = printer.sink();
    let outcome = race(timeout, async {
        let ts = std::slice::from_mut(&mut tracker);
        follow::run_until_next(f, ts, &mut sink).await?;
        Ok(())
    })
    .await?;
    match outcome {
        Ok(()) => {
            let done = tracker.done.clone().unwrap_or_default();
            let r = f.result(&sid, &done, url).await?;
            Ok(finish(ctx, r.as_ref(), printer.format))
        }
        Err(stop) => {
            let interrupt = interrupt_on_exit || (stop == Stop::Timeout && interrupt_on_timeout);
            Err(stopped(f, &sid, tracker.turn(), stop, interrupt).await)
        }
    }
}

/// `opc -p`.
async fn print(ctx: &mut Ctx, args: RunArgs, message: String) -> Result<i32> {
    let format = args.format();
    if args.include_partial_messages && format != Format::StreamJson {
        return Err(Error::usage("--include-partial-messages needs --output-format stream-json"));
    }
    if args.interrupt_on_timeout && args.timeout.is_none() {
        return Err(Error::usage("--interrupt-on-timeout needs --timeout"));
    }
    if args.session.is_none() && args.delivery.given() {
        return Err(Error::usage("--steer, --queue and --interrupt are for an existing session: pass -s <id>"));
    }
    ctx.require_key()?;
    ctx.http.set_deadline(args.timeout.map(|t| Instant::now() + t));
    let on_ask = args.on_ask.unwrap_or(OnAsk::Fail);
    let deltas = format == Format::StreamJson && args.include_partial_messages;
    let progress = ctx.tty.stderr && !ctx.global.quiet && format == Format::Text;

    let (sid, turn, seq, steered, settings) = match &args.session {
        Some(target) => {
            reject_new_session_options(&args.new)?;
            let resolved = super::resolve::resolve(ctx, target).await?;
            let sid = resolved.id;
            let wire = ctx.open_wire(vec![Attach { session_id: sid.clone(), ..Default::default() }], deltas);
            let key = derived_key(args.new.idempotency_key.as_deref(), "send");
            let if_busy = args.delivery.if_busy().as_str();
            let (wire, sent) = tokio::join!(wire, send(ctx, &sid, &message, if_busy, Some(&key)));
            let (wire, rx) = wire?;
            let sent = sent?;
            let steered = matches!(sent.delivery.as_str(), "steered" | "held").then(|| message.clone());
            let f = Follower::new(wire, rx, &[(sid.clone(), false)]);
            (sid, sent.turn, sent.seq, steered, (f, resolved.session.map(|s| s.settings)))
        }
        None => {
            let minted = new_session_id(ctx, &args.new)?;
            let wire = ctx.open_wire(vec![Attach { session_id: minted.clone(), after: Some(0), ..Default::default() }], deltas);
            let (wire, created) = tokio::join!(wire, create(ctx, &minted, &args.new, Some(&message)));
            let (wire, rx) = wire?;
            let (created, sent) = created?;
            let mut f = Follower::new(wire, rx, &[(minted.clone(), true)]);
            let sid = created.session.id.clone();
            if sid != minted {
                // A repeat of an earlier create: follow the original session.
                f.forget(&minted);
                f.attach(Attach { session_id: sid.clone(), after: Some(0), ..Default::default() });
            }
            let (turn, seq) = match (sent, created.turn) {
                (Some(s), _) => (s.turn, s.seq),
                (None, Some(t)) => (t, created.seq),
                (None, None) => return Err(Error::new("internal", "the API created the session without the message")),
            };
            cache::upsert_session(ctx.http.api_url(), &created.session);
            (sid, turn, seq, None, (f, Some(created.session.settings)))
        }
    };
    let (mut f, settings) = settings;
    let turn: Turn = turn;
    remember(&sid, Some(&turn.id));
    let url = ctx.config.dashboard_url(&sid);
    crate::timing::get().new_turn(&turn.id);
    if steered.is_none() {
        crate::telemetry::print_turn(&sid, &turn.id);
    }
    // The handle line: even with -q, so a script that gives up knows where to return.
    eprintln!("opc: session {sid} turn {} {url}", turn.id);
    if format == Format::StreamJson {
        print_line(&json!({"type": "system", "subtype": "init", "sessionId": sid, "turnId": turn.id, "url": url, "settings": settings}));
    }
    let tracker = Tracker::new(&sid, Goal::Turn(turn.id.clone()), on_ask, args.wait_subagents).steered(steered).sent_seq(seq);
    let printer = Printer { format, partial: args.include_partial_messages, progress, sessions: vec![sid.clone()] };
    follow_turn(ctx, &mut f, tracker, &printer, &url, args.timeout, args.interrupt_on_timeout, args.interrupt_on_exit).await
}
