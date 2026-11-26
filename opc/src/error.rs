//! Command failures and exit codes, in one place.
//!
//! A turn's outcome is never an `Error`: it is a Result object on stdout (see
//! `api::result`). An `Error` is a failure of the command itself, printed as
//! `{"error": {code, message, retryable, …}}` on stderr when any JSON format is
//! selected, and as `opc: <message>` otherwise.

use serde_json::{Map, Value, json};
use std::fmt;

pub type Result<T, E = Error> = std::result::Result<T, E>;

/// Exit codes, as documented in `docs/reference/exit-codes.mdx`.
pub mod exit {
    pub const OK: i32 = 0;
    pub const TURN_FAILED: i32 = 1;
    pub const USAGE: i32 = 2;
    pub const AUTH: i32 = 3;
    pub const UNREACHABLE: i32 = 4;
    pub const WAITING: i32 = 5;
    pub const CREDITS: i32 = 6;
    pub const TIMEOUT: i32 = 124;
    pub const INTERRUPTED: i32 = 130;
}

#[derive(Debug, Clone)]
pub struct Error {
    pub code: String,
    pub message: String,
    pub retryable: bool,
    /// The HTTP status, when the error came from the API.
    pub status: Option<u16>,
    /// Extra fields: `matches`, `reason`, `minVersion`, `retryAfterMs`, `ask`, …
    pub extra: Map<String, Value>,
    /// Lines printed after the message for people (never in JSON).
    pub hint: Option<String>,
}

impl Error {
    pub fn new(code: impl Into<String>, message: impl Into<String>) -> Self {
        let code = code.into();
        let retryable = matches!(
            code.as_str(),
            "unreachable" | "computer_unavailable" | "rate_limited" | "queue_full" | "timeout" | "unavailable" | "internal"
        );
        Error { code, message: message.into(), retryable, status: None, extra: Map::new(), hint: None }
    }

    pub fn usage(message: impl Into<String>) -> Self {
        Error::new("usage", message)
    }

    pub fn unreachable(message: impl Into<String>) -> Self {
        Error::new("unreachable", message)
    }

    pub fn not_logged_in() -> Self {
        Error::new("not_logged_in", "not logged in: run `opc login`, or set OPENCOMPUTER_API_KEY")
    }

    pub fn timeout() -> Self {
        Error::new("timeout", "timed out")
    }

    pub fn with(mut self, key: &str, value: impl Into<Value>) -> Self {
        self.extra.insert(key.to_string(), value.into());
        self
    }

    pub fn hint(mut self, hint: impl Into<String>) -> Self {
        self.hint = Some(hint.into());
        self
    }

    /// The API's error body (`{error: {...}}` or the bare object) with its status.
    pub fn from_api(status: u16, body: &Value) -> Self {
        let obj = body.get("error").unwrap_or(body);
        let code = obj
            .get("code")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| default_code_for_status(status).to_string());
        let message = obj
            .get("message")
            .and_then(Value::as_str)
            .map(str::to_string)
            .unwrap_or_else(|| format!("the API answered {status}"));
        let retryable = obj
            .get("retryable")
            .and_then(Value::as_bool)
            .unwrap_or(matches!(status, 429 | 500..=599) || code == "queue_full");
        let mut extra = Map::new();
        if let Some(map) = obj.as_object() {
            for (k, v) in map {
                if !matches!(k.as_str(), "code" | "message" | "retryable" | "status") {
                    extra.insert(k.clone(), v.clone());
                }
            }
        }
        Error { code, message, retryable, status: Some(status), extra, hint: None }
    }

    pub fn retry_after_ms(&self) -> Option<u64> {
        self.extra.get("retryAfterMs").and_then(Value::as_u64)
    }

    pub fn exit_code(&self) -> i32 {
        use exit::*;
        match self.code.as_str() {
            "usage" | "upgrade_required" | "session_ambiguous" | "session_not_found" | "push_rejected"
            | "pull_rejected" => USAGE,
            "not_logged_in" | "unauthenticated" | "forbidden" | "computer_not_set_up" => AUTH,
            "unreachable" | "computer_unavailable" | "rate_limited" | "queue_full" => UNREACHABLE,
            "insufficient_credits" => CREDITS,
            "turn_failed" | "turn_cancelled" => TURN_FAILED,
            "waiting" | "subagent_running" => WAITING,
            "timeout" => TIMEOUT,
            "interrupted" => INTERRUPTED,
            // `retryable` and the exit code always agree: retry on 4.
            _ if self.retryable => UNREACHABLE,
            _ => match self.status {
                Some(s) if s >= 500 => UNREACHABLE,
                _ => USAGE,
            },
        }
    }

    pub fn to_json(&self) -> Value {
        let mut obj = Map::new();
        obj.insert("code".into(), json!(self.code));
        obj.insert("message".into(), json!(self.message));
        obj.insert("retryable".into(), json!(self.retryable));
        for (k, v) in &self.extra {
            obj.insert(k.clone(), v.clone());
        }
        if let Some(h) = &self.hint {
            obj.entry("hint").or_insert_with(|| json!(h));
        }
        json!({ "error": Value::Object(obj) })
    }

    /// The last line of a `stream-json` stdout when the command fails.
    pub fn stream_result_line(&self) -> Value {
        let inner = self.to_json()["error"].clone();
        json!({ "type": "result", "subtype": "error", "isError": true, "error": inner })
    }
}

fn default_code_for_status(status: u16) -> &'static str {
    match status {
        400 => "invalid_request",
        401 => "unauthenticated",
        402 => "insufficient_credits",
        403 => "forbidden",
        404 => "not_found",
        409 => "conflict",
        413 => "too_large",
        426 => "upgrade_required",
        429 => "rate_limited",
        503 => "unavailable",
        s if s >= 500 => "internal",
        _ => "invalid_request",
    }
}

impl fmt::Display for Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.message)
    }
}

impl std::error::Error for Error {}

impl From<std::io::Error> for Error {
    fn from(e: std::io::Error) -> Self {
        Error::new("io", e.to_string())
    }
}

impl From<serde_json::Error> for Error {
    fn from(e: serde_json::Error) -> Self {
        Error::new("invalid_response", format!("could not read the response: {e}"))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exit_codes_follow_the_table() {
        for (code, exit) in [
            ("usage", 2),
            ("upgrade_required", 2),
            ("session_ambiguous", 2),
            ("session_not_found", 2),
            ("push_rejected", 2),
            ("pull_rejected", 2),
            ("not_logged_in", 3),
            ("unauthenticated", 3),
            ("forbidden", 3),
            ("computer_not_set_up", 3),
            ("unreachable", 4),
            ("computer_unavailable", 4),
            ("rate_limited", 4),
            ("queue_full", 4),
            ("insufficient_credits", 6),
            ("turn_failed", 1),
            ("turn_cancelled", 1),
            ("waiting", 5),
            ("timeout", 124),
            ("subagent_running", 5),
            ("internal", 4),
            ("io", 2),
        ] {
            assert_eq!(Error::new(code, "x").exit_code(), exit, "{code}");
        }
    }

    #[test]
    fn retryable_errors_exit_four() {
        for code in ["internal", "unavailable", "unreachable", "computer_unavailable"] {
            let e = Error::new(code, "x");
            assert!(e.retryable && e.exit_code() == 4, "{code}");
        }
        let e = Error::from_api(409, &json!({"error": {"code": "busy", "message": "m", "retryable": true}}));
        assert_eq!(e.exit_code(), 4);
    }

    #[test]
    fn unknown_api_codes_exit_by_status() {
        let e = Error::from_api(409, &json!({"error": {"code": "id_conflict", "message": "m", "retryable": false}}));
        assert_eq!(e.exit_code(), 2);
        let e = Error::from_api(500, &json!({"error": {"code": "internal", "message": "m", "retryable": true}}));
        assert_eq!(e.exit_code(), 4);
        assert!(e.retryable);
    }

    #[test]
    fn json_shape_keeps_extra_fields() {
        let e = Error::new("session_ambiguous", "7f matches 2 sessions").with("matches", json!(["cs_a", "cs_b"]));
        let v = e.to_json();
        assert_eq!(v["error"]["code"], "session_ambiguous");
        assert_eq!(v["error"]["retryable"], false);
        assert_eq!(v["error"]["matches"][1], "cs_b");
    }
}
