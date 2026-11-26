//! Logs for people debugging `opc`: `OPC_LOG=error|warn|info|debug` or `-v`,
//! to standard error. Keys and tickets are never logged.

use std::sync::atomic::{AtomicU8, Ordering};

static LEVEL: AtomicU8 = AtomicU8::new(1);

pub const ERROR: u8 = 0;
pub const WARN: u8 = 1;
pub const INFO: u8 = 2;
pub const DEBUG: u8 = 3;

pub fn init(verbose: bool) {
    let level = if verbose {
        DEBUG
    } else {
        match std::env::var("OPC_LOG").unwrap_or_default().to_ascii_lowercase().as_str() {
            "error" => ERROR,
            "info" => INFO,
            "debug" | "trace" => DEBUG,
            _ => WARN,
        }
    };
    LEVEL.store(level, Ordering::Relaxed);
}

pub fn enabled(level: u8) -> bool {
    LEVEL.load(Ordering::Relaxed) >= level
}

fn emit(level: u8, tag: &str, msg: &str) {
    if enabled(level) {
        let t = crate::timing::since_start();
        eprintln!("opc: {tag} {:>7.1}ms {msg}", t.as_secs_f64() * 1000.0);
    }
}

pub fn debug(msg: &str) {
    emit(DEBUG, "debug", msg);
}
pub fn info(msg: &str) {
    emit(INFO, "info ", msg);
}
pub fn warn(msg: &str) {
    emit(WARN, "warn ", msg);
}
