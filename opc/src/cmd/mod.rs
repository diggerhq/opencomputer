//! Commands. [`Ctx`] is what every command gets: the configuration, the
//! shared HTTP connection, the global options and what the terminal is.

pub mod ask;
pub mod attach;
pub mod auth;
pub mod config;
pub mod doctor;
pub mod follow;
pub mod help;
pub mod log;
pub mod ls;
pub mod manage;
pub mod new;
pub mod pull;
pub mod push;
pub mod resolve;
pub mod run;
pub mod send;
pub mod shell;
pub mod subagents;
pub mod transfer;
pub mod wait;
pub mod watch;

use crate::cli::{Cli, Command, Global};
use crate::config::{Config, DEFAULT_API_URL, DEFAULT_WIRE_URL};
use crate::error::{Error, Result};
use crate::http::Http;
use crate::wire::{Attach, Wire, WireEvent, WireHandle, WireOptions};
use serde_json::Value;
use std::io::{IsTerminal, Read, Write};
use std::time::Duration;
use tokio::sync::mpsc::UnboundedReceiver;

/// Which standard streams are terminals.
#[derive(Debug, Clone, Copy, Default)]
pub struct Ttys {
    pub stdin: bool,
    pub stdout: bool,
    pub stderr: bool,
}

impl Ttys {
    pub fn detect() -> Ttys {
        Ttys { stdin: std::io::stdin().is_terminal(), stdout: std::io::stdout().is_terminal(), stderr: std::io::stderr().is_terminal() }
    }
    pub fn interactive(&self) -> bool {
        self.stdin && self.stdout
    }
}

pub struct Ctx {
    pub config: Config,
    pub http: Http,
    pub global: Global,
    pub tty: Ttys,
    /// Colors on: a terminal on stdout, no `NO_COLOR`, no `--no-color`.
    pub color: bool,
}

impl Ctx {
    pub fn new(global: Global, tty: Ttys) -> Result<Ctx> {
        let config = Config::load();
        let http = Http::new(&config)?;
        if tty.stderr && !global.quiet {
            crate::http::set_starting_notice(Some(Box::new(|| eprintln!("opc: starting your computer…"))));
        }
        let no_color = global.no_color || std::env::var_os("NO_COLOR").is_some_and(|v| !v.is_empty());
        Ok(Ctx { config, http, global, tty, color: tty.stdout && !no_color })
    }

    /// Reloads the configuration (after `opc login`).
    pub fn reload(&mut self) -> Result<()> {
        self.config = Config::load();
        self.http = Http::new(&self.config)?;
        Ok(())
    }

    /// A progress message for people: stderr, only when it is a terminal and
    /// not `-q`.
    pub fn progress(&self, msg: &str) {
        if self.tty.stderr && !self.global.quiet {
            eprintln!("opc: {msg}");
        }
    }

    /// A message for people that is printed even when stderr is not a
    /// terminal (but not with `-q`).
    pub fn note(&self, msg: &str) {
        if !self.global.quiet {
            eprintln!("opc: {msg}");
        }
    }

    pub fn require_key(&self) -> Result<&str> {
        self.config.require_key()
    }

    /// The session's dashboard link.
    pub fn url_for(&self, session: Option<&crate::api::types::Session>, id: &str) -> String {
        session.and_then(|s| s.urls.dashboard.clone()).unwrap_or_else(|| self.config.dashboard_url(id))
    }

    /// The WebSocket URL: `OPC_WIRE_URL`, then the one `/me` gave last time,
    /// then `/me` (only for an API other than production), then the default.
    /// The connection's URL when it is known without the network: from
    /// `OPC_WIRE_URL`, the cache, or the default for the default API.
    pub fn wire_url_now(&self) -> Option<String> {
        if let Ok(u) = std::env::var("OPC_WIRE_URL")
            && !u.trim().is_empty() {
                return Some(u.trim().to_string());
            }
        if let Some(u) = crate::cache::wire_url(&self.config.api_url) {
            return Some(u);
        }
        // Another environment's wire is named by its own `/me`.
        (self.config.api_url == DEFAULT_API_URL).then(|| DEFAULT_WIRE_URL.to_string())
    }

    /// The WebSocket URL. For an API other than production it comes from
    /// `/me` (or `OPC_WIRE_URL`) only: a key is never shown to the production
    /// wire on another environment's behalf.
    pub async fn wire_url(&self) -> Result<String> {
        if let Some(u) = self.wire_url_now() {
            return Ok(u);
        }
        let api = &self.config.api_url;
        let me = self.http.get("/me", &[]).await.map_err(|e| {
            let mut e2 = Error::new(&e.code, format!("cannot find the wire URL: GET {api}/me failed: {}", e.message));
            e2.status = e.status;
            e2.hint("set OPC_WIRE_URL to connect without it")
        })?;
        match crate::wire::reconnect::wire_url_from_me(&me) {
            Some(u) => {
                crate::cache::set_wire_url(api, &u);
                Ok(u)
            }
            None => Err(Error::new("computer_not_set_up", format!("{api} gave no wire URL (computer.wireUrl in /me)")).hint("set OPC_WIRE_URL, or finish setup at the dashboard, under Computer")),
        }
    }

    /// Options for a non-interactive command's connection: gives up after
    /// two minutes of continuous disconnection.
    pub async fn wire_options(&self, deltas: bool) -> Result<WireOptions> {
        Ok(WireOptions {
            url: self.wire_url().await?,
            key: self.require_key()?.to_string(),
            deltas,
            resume: false,
            read_only: false,
            give_up: Some(Duration::from_secs(120)),
        })
    }

    /// Opens the connection with these sessions attached.
    pub async fn open_wire(&self, attaches: Vec<Attach>, deltas: bool) -> Result<(WireHandle, UnboundedReceiver<WireEvent>)> {
        let opts = self.wire_options(deltas).await?;
        Ok(Wire::open(opts, attaches, Some(self.http.clone())))
    }
}

/// Writes JSON to stdout: indented for a terminal, one line otherwise.
pub fn print_json(ctx: &Ctx, v: &Value) {
    let s = if ctx.tty.stdout { serde_json::to_string_pretty(v) } else { serde_json::to_string(v) }.unwrap_or_default();
    println_out(&s);
}

/// One JSON line to stdout, flushed (for `stream-json`).
pub fn print_line(v: &Value) {
    println_out(&serde_json::to_string(v).unwrap_or_default());
}

/// Prints a line to stdout and flushes; a closed pipe ends the process
/// quietly, as `head` expects.
pub fn println_out(s: &str) {
    let mut out = std::io::stdout().lock();
    if writeln!(out, "{s}").and_then(|_| out.flush()).is_err() {
        std::process::exit(0);
    }
}

/// Standard input as a message (UTF-8, as given).
pub fn read_stdin() -> Result<String> {
    let mut s = String::new();
    std::io::stdin().read_to_string(&mut s).map_err(|e| Error::usage(format!("cannot read standard input: {e}")))?;
    Ok(s)
}

/// How long a message given as words waits for piped input to start.
const STDIN_GRACE_MS: i32 = 200;

/// Whether stdin has input to add to a message given as words: a regular
/// file, or a pipe or socket that has data (or has closed) within
/// [`STDIN_GRACE_MS`]. A pipe a parent left open and never writes to
/// (`execFile`, `subprocess.run(stdin=PIPE)`, `docker run -i`) is ignored
/// rather than read forever.
pub fn stdin_has_input() -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::FileTypeExt;
        let Ok(meta) = std::fs::metadata("/dev/stdin") else { return false };
        let ft = meta.file_type();
        if ft.is_file() {
            return true;
        }
        if !(ft.is_fifo() || ft.is_socket()) {
            return false;
        }
        let mut fd = libc::pollfd { fd: 0, events: libc::POLLIN, revents: 0 };
        // SAFETY: one valid pollfd for the duration of the call.
        let n = unsafe { libc::poll(&mut fd, 1, STDIN_GRACE_MS) };
        n > 0 && fd.revents & (libc::POLLIN | libc::POLLHUP) != 0
    }
    #[cfg(not(unix))]
    {
        false
    }
}

/// The message from words, `-` and standard input:
/// - `-` alone reads standard input;
/// - words and piped input: the words, a blank line, then the input
///   (`git diff | opc -p "review this"`), when `with_stdin`.
pub fn message_from(words: &[String], with_stdin: bool, tty: Ttys) -> Result<Option<String>> {
    if words.len() == 1 && words[0] == "-" {
        let s = read_stdin()?;
        return Ok(Some(s));
    }
    let arg = (!words.is_empty()).then(|| words.join(" "));
    let piped = if with_stdin && !tty.stdin && (arg.is_none() || stdin_has_input()) { Some(read_stdin()?) } else { None };
    Ok(match (arg, piped) {
        (Some(a), Some(p)) if !p.trim().is_empty() => Some(format!("{a}\n\n{p}")),
        (Some(a), _) => Some(a),
        (None, Some(p)) if !p.trim().is_empty() => Some(p),
        _ => None,
    })
}

pub fn check_message(m: &str) -> Result<()> {
    if m.trim().is_empty() {
        return Err(Error::usage("the message is empty"));
    }
    if m.chars().count() > 100_000 {
        return Err(Error::usage("the message is longer than 100,000 characters"));
    }
    Ok(())
}

/// Runs a parsed command line.
pub async fn dispatch(cli: Cli, ctx: &mut Ctx) -> Result<i32> {
    let Some(command) = cli.command else {
        return run::root(ctx, cli.run, cli.message).await;
    };
    match command {
        Command::New(a) => new::run(ctx, a).await,
        Command::A(a) => attach::run(ctx, a).await,
        Command::Ls(a) => ls::run(ctx, a).await,
        Command::Log(a) => log::run(ctx, a).await,
        Command::Send(a) => send::run(ctx, a).await,
        Command::Wait(a) => wait::run(ctx, a).await,
        Command::Watch(a) => watch::run(ctx, a).await,
        Command::Interrupt(a) => manage::interrupt(ctx, a).await,
        Command::Ask(a) => ask::run(ctx, a).await,
        Command::Subagents(a) => subagents::run(ctx, a).await,
        Command::Rename(a) => manage::rename(ctx, a).await,
        Command::Archive(a) => manage::archive(ctx, a, true).await,
        Command::Unarchive(a) => manage::archive(ctx, a, false).await,
        Command::Open(a) => manage::open(ctx, a).await,
        Command::Diff(a) => manage::diff(ctx, a).await,
        Command::Push(a) => push::run(ctx, a).await,
        Command::Pull(a) => pull::run(ctx, a).await,
        Command::Shell(a) => shell::run(ctx, a).await,
        Command::Login(a) => auth::login(ctx, a).await,
        Command::Logout => auth::logout(ctx).await,
        Command::Whoami(a) => auth::whoami(ctx, a).await,
        Command::Doctor(a) => doctor::run(ctx, a).await,
        Command::Schema(a) => help::schema(a),
        Command::Help(a) => help::help(a),
        Command::Completion(a) => help::completion(a),
        Command::Config(c) => config::run(ctx, c),
    }
}
