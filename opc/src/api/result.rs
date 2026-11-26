//! The Result object: the outcome of one turn, as `opc -p`, `opc wait`,
//! `opc watch` and `opc send --wait` print it
//! (`docs/api/reference/objects.mdx#result`).

use crate::error::exit;
use serde_json::{Value, json};
use time::OffsetDateTime;
use time::format_description::well_known::Rfc3339;

/// Builds the Result from the turn as the server returned it (kept as raw
/// JSON so it is printed exactly), and the open ask when the turn waits.
///
/// `subagents` are the subagents the turn launched, as known now; a turn
/// completes while its background subagents still run.
pub fn build(turn: &Value, session_id: &str, url: &str, ask: Option<&Value>, subagents: &[crate::api::types::Subagent]) -> Value {
    let status_raw = turn.get("status").and_then(Value::as_str).unwrap_or("");
    let waiting = ask.is_some() && !matches!(status_raw, "completed" | "failed" | "cancelled");
    let status = if waiting { "waiting" } else { status_raw };
    let subtype = match status {
        "completed" => "success",
        "failed" => "error",
        "cancelled" => "cancelled",
        "waiting" => "waiting",
        _ => "error",
    };
    let s = |k: &str| turn.get(k).and_then(Value::as_str);
    let start = s("createdAt").and_then(parse_time);
    let end = if waiting {
        ask.and_then(|a| a.get("createdAt")).and_then(Value::as_str).and_then(parse_time)
    } else {
        s("endedAt").and_then(parse_time)
    };
    let duration_ms = match (start, end) {
        (Some(a), Some(b)) if b >= a => ((b - a).whole_milliseconds()).max(0) as u64,
        _ => 0,
    };
    let null_if_missing = |k: &str| turn.get(k).cloned().unwrap_or(Value::Null);
    json!({
        "type": "result",
        "subtype": subtype,
        "isError": subtype == "error",
        "sessionId": session_id,
        "turnId": turn.get("id").cloned().unwrap_or(Value::Null),
        "status": status,
        "result": if status == "completed" { null_if_missing("text") } else { Value::Null },
        "error": if status == "failed" { null_if_missing("error") } else { Value::Null },
        "reason": if status == "cancelled" { null_if_missing("reason") } else { Value::Null },
        "ask": if waiting { ask.cloned().unwrap_or(Value::Null) } else { Value::Null },
        "url": url,
        "durationMs": duration_ms,
        "usage": null_if_missing("usage"),
        "subagents": subagents.iter().map(|s| s.brief()).collect::<Vec<_>>(),
        "turn": turn,
    })
}

/// The exit code a Result stands for.
pub fn exit_code(result: &Value) -> i32 {
    match result.get("status").and_then(Value::as_str) {
        Some("completed") => exit::OK,
        Some("waiting") => exit::WAITING,
        _ => exit::TURN_FAILED,
    }
}

/// The combined code for several Results: `--all` is `0` when every one
/// completed, else `5` when any waits, else `1`.
pub fn combine_all(codes: &[i32]) -> i32 {
    if codes.iter().all(|c| *c == exit::OK) {
        exit::OK
    } else if codes.contains(&exit::WAITING) {
        exit::WAITING
    } else {
        exit::TURN_FAILED
    }
}

pub fn parse_time(s: &str) -> Option<OffsetDateTime> {
    OffsetDateTime::parse(s, &Rfc3339).ok()
}

/// The text people see for a Result without `--json`.
pub fn text(result: &Value) -> String {
    let status = result.get("status").and_then(Value::as_str).unwrap_or("");
    match status {
        "completed" => result.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
        _ => String::new(),
    }
}

/// One line for standard error about a Result that did not complete.
pub fn describe_failure(result: &Value) -> Option<String> {
    let session = result.get("sessionId").and_then(Value::as_str).unwrap_or("");
    match result.get("status").and_then(Value::as_str)? {
        "failed" => {
            let e = result.get("error");
            let code = e.and_then(|e| e.get("code")).and_then(Value::as_str).unwrap_or("failed");
            let msg = e.and_then(|e| e.get("message")).and_then(Value::as_str).unwrap_or("");
            Some(if msg.is_empty() { format!("the turn failed: {code}") } else { format!("the turn failed: {msg} ({code})") })
        }
        "cancelled" => {
            let reason = result.get("reason").and_then(Value::as_str).unwrap_or("cancelled");
            Some(format!("the turn was cancelled: {reason} (session {session})"))
        }
        "waiting" => result.get("ask").map(|a| waiting_message(a, session)),
        _ => None,
    }
}

/// `opc: waiting for a person: …` and the commands that answer the ask.
pub fn waiting_message(ask: &Value, session_id: &str) -> String {
    let ask: crate::api::types::Ask = serde_json::from_value(ask.clone()).unwrap_or_default();
    // A secret request is answered in Slack only; here it can be skipped.
    let how = if ask.kind == "secret" { "it is answered in Slack, or skip it with one of" } else { "answer it with one of" };
    let mut out = format!("waiting for a person: {} in session {session_id}\n     {how}:\n", ask.describe());
    let id = &ask.id;
    let cmds: Vec<String> = match ask.kind.as_str() {
        "approval" => {
            let mut v = vec![format!("opc ask allow {id}")];
            if ask.approval.as_ref().and_then(|a| a.always_allows.as_ref()).is_some() {
                v.push(format!("opc ask always {id}"));
            }
            v.push(format!("opc ask deny {id} -m \"<what to do instead>\""));
            v
        }
        "question" => vec![format!("opc ask answer {id} --choice \"<label>\""), format!("opc ask dismiss {id}")],
        _ => vec![format!("opc ask dismiss {id}")],
    };
    for c in cmds {
        out.push_str(&format!("       {c}\n"));
    }
    out.push_str(&format!("       opc a {session_id}"));
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn completed() {
        let turn = json!({"id": "tn_4m8q2x7c1v9b", "status": "completed", "text": "done", "createdAt": "2026-10-26T09:00:00.000Z", "endedAt": "2026-10-26T09:00:48.211Z", "usage": {"costUsd": "0.41"}});
        let r = build(&turn, "cs_7f3a9k2m4q8r1t6v", "https://x", None, &[]);
        assert_eq!(r["subtype"], "success");
        assert_eq!(r["result"], "done");
        assert_eq!(r["durationMs"], 48211);
        assert_eq!(r["isError"], false);
        assert_eq!(exit_code(&r), 0);
    }

    #[test]
    fn waiting_and_failed() {
        let turn = json!({"id": "tn_4m8q2x7c1v9b", "status": "running", "createdAt": "2026-10-26T09:00:00Z"});
        let ask = json!({"id": "ak_9b4m8q2x7c1v", "kind": "approval", "status": "open", "createdAt": "2026-10-26T09:00:01Z", "approval": {"title": "Bash: terraform apply", "alwaysAllows": null}});
        let r = build(&turn, "cs_7f3a9k2m4q8r1t6v", "u", Some(&ask), &[]);
        assert_eq!(r["status"], "waiting");
        assert_eq!(r["durationMs"], 1000);
        assert_eq!(exit_code(&r), 5);
        let msg = waiting_message(&ask, "cs_7f3a9k2m4q8r1t6v");
        assert!(msg.starts_with("waiting for a person: approval for \"Bash: terraform apply\" in session cs_7f3a9k2m4q8r1t6v"));
        assert!(!msg.contains("always"));
        let secret = json!({"id": "ak_2c7v1b4m8q9x", "kind": "secret", "status": "open", "secret": {"name": "STRIPE_API_KEY", "file": false}});
        let msg = waiting_message(&secret, "cs_7f3a9k2m4q8r1t6v");
        assert!(msg.contains("answered in Slack") && msg.contains("opc ask dismiss ak_2c7v1b4m8q9x"), "{msg}");
        assert!(!msg.contains("opc secret"), "{msg}");
        let failed = json!({"id": "tn_4m8q2x7c1v9b", "status": "failed", "error": {"code": "model_error", "message": "x"}});
        let r = build(&failed, "cs_7f3a9k2m4q8r1t6v", "u", None, &[]);
        assert_eq!(r["subtype"], "error");
        assert_eq!(r["isError"], true);
        assert_eq!(exit_code(&r), 1);
        assert_eq!(combine_all(&[0, 1, 5]), 5);
        assert_eq!(combine_all(&[0, 1]), 1);
    }
}
