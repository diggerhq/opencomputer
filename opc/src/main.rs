//! `opc`: the terminal for your organization's computer.
#![allow(clippy::result_large_err)]

use opc::cli::{self, Format};
use opc::cmd::{self, Ctx, Ttys};
use opc::error::{Error, exit};
use opc::{http, log, net, telemetry, timing};

fn main() {
    timing::init();
    telemetry::install_panic_hook();
    let args: Vec<String> = std::env::args().skip(1).collect();
    let code = run(args);
    std::process::exit(code);
}

/// How errors are printed for this command line.
#[derive(Clone, Copy)]
struct ErrStyle {
    json: bool,
    stream: bool,
}

fn run(args: Vec<String>) -> i32 {
    let tty = Ttys::detect();
    let parsed = match cli::parse(args.clone()) {
        Ok(c) => c,
        Err(e) => return parse_failure(&args, e),
    };
    log::init(parsed.global.verbose);
    // Load the platform's TLS roots while config and caches are read.
    std::thread::spawn(net::prewarm_tls);
    let style = err_style(&parsed, tty);
    let timing_on = parsed.global.timing;
    let quiet = parsed.global.quiet;

    let rt = match tokio::runtime::Builder::new_multi_thread().worker_threads(2).enable_all().build() {
        Ok(rt) => rt,
        Err(e) => return report(&Error::new("internal", format!("cannot start: {e}")), style),
    };
    let code = rt.block_on(async move {
        let mut ctx = match Ctx::new(parsed.global.clone(), tty) {
            Ok(c) => c,
            Err(e) => return report(&e, style),
        };
        let code = match cmd::dispatch(parsed, &mut ctx).await {
            Ok(code) => code,
            Err(e) => report(&e, style),
        };
        // The connection's last telemetry frames, if one is still writing.
        telemetry::drain(std::time::Duration::from_millis(200)).await;
        code
    });
    // Don't wait for background tasks (an idle connection, a cache write
    // already done synchronously) to wind down.
    rt.shutdown_background();

    if timing_on {
        eprint!("{}", timing::get().report());
    }
    if !quiet && tty.stderr
        && let Some(latest) = http::latest_version()
            && newer(latest, env!("CARGO_PKG_VERSION")) {
                eprintln!("opc: opc {latest} is out (you have {}): https://github.com/diggerhq/opc#install", env!("CARGO_PKG_VERSION"));
            }
    code
}

fn err_style(c: &cli::Cli, tty: Ttys) -> ErrStyle {
    match &c.command {
        Some(cmd) => ErrStyle { json: cmd.wants_json(), stream: cmd.is_stream_json() },
        None => {
            let print = c.run.print || (!tty.interactive() && !c.message.is_empty()) || !tty.stdin;
            let f = c.run.format();
            ErrStyle { json: print && f != Format::Text, stream: print && f == Format::StreamJson }
        }
    }
}

fn parse_failure(args: &[String], e: clap::Error) -> i32 {
    use clap::error::ErrorKind;
    match e.kind() {
        ErrorKind::DisplayHelp | ErrorKind::DisplayVersion | ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand => {
            let _ = e.print();
            return if e.kind() == ErrorKind::DisplayHelpOnMissingArgumentOrSubcommand { exit::USAGE } else { exit::OK };
        }
        _ => {}
    }
    let json = args.iter().any(|a| a == "--json" || a == "stream-json" || a == "json" || a == "--output-format=json" || a == "--output-format=stream-json");
    let err = match cli::looks_like_message(args, &e) {
        Some(msg) => Error::usage(msg),
        None => cli::usage_error(&e),
    };
    if json {
        eprintln!("{}", serde_json::to_string(&err.to_json()).unwrap_or_default());
        // A reader of the stream always gets a last line.
        let stream = args.windows(2).any(|w| w[0] == "--output-format" && w[1] == "stream-json") || args.iter().any(|a| a == "--output-format=stream-json");
        if stream {
            println!("{}", serde_json::to_string(&err.stream_result_line()).unwrap_or_default());
        }
    } else {
        let rendered = e.render().to_string();
        if cli::looks_like_message(args, &e).is_some() {
            eprintln!("opc: {}", err.message);
        } else {
            eprint!("{rendered}");
        }
    }
    exit::USAGE
}

/// Prints a command failure: JSON on stderr when JSON is selected (and the
/// error Result as stdout's last line for stream-json), else `opc: …`.
fn report(e: &Error, style: ErrStyle) -> i32 {
    if e.code == "silent" {
        return e.exit_code_or_extra();
    }
    if style.json {
        eprintln!("{}", serde_json::to_string(&e.to_json()).unwrap_or_default());
        if style.stream {
            cmd::print_line(&e.stream_result_line());
        }
    } else {
        eprintln!("opc: {}", e.message);
        if let Some(h) = &e.hint {
            for line in h.lines() {
                eprintln!("     {line}");
            }
        }
    }
    e.exit_code()
}

trait SilentExit {
    fn exit_code_or_extra(&self) -> i32;
}

impl SilentExit for Error {
    /// An error already reported to the person carries its exit code.
    fn exit_code_or_extra(&self) -> i32 {
        self.extra.get("exit").and_then(serde_json::Value::as_i64).map(|c| c as i32).unwrap_or(exit::TURN_FAILED)
    }
}

/// Whether version `a` is newer than `b` (dotted numbers).
fn newer(a: &str, b: &str) -> bool {
    let parse = |s: &str| s.split(['.', '-']).take(3).map(|p| p.parse::<u64>().unwrap_or(0)).collect::<Vec<_>>();
    parse(a) > parse(b)
}
