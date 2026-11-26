//! `opc secrets set|ls|rm`: a session's own secrets ("This session only").
//!
//! A value goes in once, from standard input or a prompt that does not echo,
//! and never comes back: not as an argument (it would land in shell history
//! and `ps`), not in output, logs or errors. Listing prints names only.

use super::resolve::{operand, session_or_last};
use super::{Ctx, print_json, println_out, read_stdin};
use crate::cli::{SecretNameArgs, SecretSetArgs, SecretsCommand, SecretsLsArgs};
use crate::error::{Error, Result};
use crate::http::session_path;
use crate::net;
use serde_json::{Value, json};

/// The API's limit on a value, in bytes.
const MAX_VALUE: usize = 64 * 1024;

pub async fn run(ctx: &Ctx, c: SecretsCommand) -> Result<i32> {
    match c {
        SecretsCommand::Set(a) => set(ctx, a).await,
        SecretsCommand::Ls(a) => ls(ctx, a).await,
        SecretsCommand::Rm(a) => rm(ctx, a).await,
    }
}

async fn set(ctx: &Ctx, a: SecretSetArgs) -> Result<i32> {
    check_name(&a.name)?;
    let target = need_session(a.session.session.as_deref(), &format!("opc secrets set {} -s <id>", a.name))?;
    ctx.require_key()?;
    // Resolve first: a wrong session fails before anyone types a value.
    let sid = session_or_last(ctx, Some(&target), true).await?.id;
    let value = read_value(ctx, &a.name, a.file)?;
    let body = json!({"value": value, "file": a.file});
    ctx.http.put(&secret_path(&sid, &a.name), &body).await.map_err(|e| map_error(e, &sid, &a.name))?;
    if a.json {
        print_json(ctx, &json!({"secret": {"name": a.name, "scope": "session", "sessionId": sid, "file": a.file}}));
    } else {
        ctx.progress(&format!("set {} on {sid}; it is in the environment of the session's next command", a.name));
    }
    Ok(0)
}

async fn ls(ctx: &Ctx, a: SecretsLsArgs) -> Result<i32> {
    let target = operand(a.id.as_deref(), a.session.session.as_deref())?;
    ctx.require_key()?;
    let sid = session_or_last(ctx, target.as_deref(), true).await?.id;
    let got = ctx.http.get(&session_path(&sid, "/secrets"), &[]).await.map_err(|e| map_error(e, &sid, ""))?;
    let secrets = got.get("secrets").and_then(Value::as_array).cloned().unwrap_or_default();
    if a.json {
        print_json(ctx, &json!({"secrets": secrets}));
        return Ok(0);
    }
    if secrets.is_empty() {
        ctx.progress(&format!("{sid} has no secrets of its own"));
    }
    for s in &secrets {
        println_out(&line(s));
    }
    Ok(0)
}

async fn rm(ctx: &Ctx, a: SecretNameArgs) -> Result<i32> {
    check_name(&a.name)?;
    let target = need_session(a.session.session.as_deref(), &format!("opc secrets rm {} -s <id>", a.name))?;
    ctx.require_key()?;
    let sid = session_or_last(ctx, Some(&target), true).await?.id;
    ctx.http.delete(&secret_path(&sid, &a.name)).await.map_err(|e| map_error(e, &sid, &a.name))?;
    if a.json {
        print_json(ctx, &json!({"deleted": {"name": a.name, "sessionId": sid}}));
    } else {
        ctx.progress(&format!("deleted {} from {sid}", a.name));
    }
    Ok(0)
}

/// Writes name a session explicitly: `-s -` still means the last one.
fn need_session(flag: Option<&str>, usage: &str) -> Result<String> {
    flag.map(str::to_string).ok_or_else(|| Error::usage(format!("which session? {usage}")))
}

fn secret_path(sid: &str, name: &str) -> String {
    session_path(sid, &format!("/secrets/{}", net::encode(name)))
}

/// The API's rule for a name; it also refuses reserved ones (`PATH`, `GIT_*`, …).
fn check_name(name: &str) -> Result<()> {
    let mut chars = name.chars();
    let ok = name.len() <= 64
        && chars.next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_');
    if ok { Ok(()) } else { Err(Error::usage(format!("{name:?} is not a secret name: use letters, digits and _, not starting with a digit (at most 64)"))) }
}

/// The value: all of standard input when it is not a terminal, else a prompt that does not echo.
fn read_value(ctx: &Ctx, name: &str, file: bool) -> Result<String> {
    let mut value = if ctx.tty.stdin { prompt_hidden(&format!("Value for {name} (not shown): "))? } else { read_stdin()? };
    // `echo "$X" | opc secrets set X` adds a newline that is not part of the value; a file is kept as given.
    if !file {
        for end in ["\r\n", "\n"] {
            if let Some(v) = value.strip_suffix(end) {
                value = v.to_string();
                break;
            }
        }
    }
    if value.trim().is_empty() {
        return Err(Error::usage(if ctx.tty.stdin { "the value is empty" } else { "the value is empty: pipe it on standard input" }));
    }
    if value.len() > MAX_VALUE {
        return Err(Error::usage(format!("the value is longer than {} KB", MAX_VALUE / 1024)));
    }
    Ok(value)
}

/// Reads one line from the terminal without echoing it. Ctrl-C and Ctrl-D give up; the terminal is restored either way.
fn prompt_hidden(prompt: &str) -> Result<String> {
    use crossterm::event::{Event, KeyCode, KeyEventKind, KeyModifiers, read};
    use std::io::Write;

    struct Raw;
    impl Drop for Raw {
        fn drop(&mut self) {
            let _ = crossterm::terminal::disable_raw_mode();
        }
    }

    eprint!("{prompt}");
    let _ = std::io::stderr().flush();
    crossterm::terminal::enable_raw_mode().map_err(|e| Error::new("io", format!("cannot set up the terminal: {e}")))?;
    let raw = Raw;
    let mut value = String::new();
    let outcome = loop {
        let ev = match read() {
            Ok(ev) => ev,
            Err(e) => break Err(Error::new("io", format!("cannot read the terminal: {e}"))),
        };
        let Event::Key(k) = ev else { continue };
        if k.kind == KeyEventKind::Release {
            continue;
        }
        let ctrl = k.modifiers.contains(KeyModifiers::CONTROL);
        match k.code {
            KeyCode::Enter => break Ok(()),
            KeyCode::Char('c') if ctrl => break Err(Error::new("interrupted", "interrupted")),
            KeyCode::Char('d') if ctrl => break Err(Error::usage("no value given")),
            KeyCode::Char('u') if ctrl => value.clear(),
            KeyCode::Backspace => {
                value.pop();
            }
            KeyCode::Char(c) if !ctrl => value.push(c),
            _ => {}
        }
    };
    drop(raw);
    eprintln!();
    outcome.map(|()| value)
}

/// One row of `opc secrets ls`: the name and who set it, never a value.
fn line(s: &Value) -> String {
    let str_of = |k: &str| s.get(k).and_then(Value::as_str).unwrap_or("");
    let mut kind = str_of("kind").to_string();
    if kind.is_empty() {
        kind = "secret".into();
    }
    if s.get("file").and_then(Value::as_bool) == Some(true) {
        kind.push_str(", file");
    }
    let by = s.get("setBy").map(|b| {
        let who = b.get("name").and_then(Value::as_str).unwrap_or("?");
        match b.get("via").and_then(Value::as_str) {
            Some(via) => format!("{who} via {via}"),
            None => who.to_string(),
        }
    });
    let mut out = format!("{:<32}  {:<14}", str_of("name"), kind);
    if let Some(by) = by {
        out.push_str(&format!("  set by {by}"));
    }
    if !str_of("updatedAt").is_empty() {
        out.push_str(&format!("  {}", str_of("updatedAt")));
    }
    out.trim_end().to_string()
}

/// The API's refusals, in the words of this command.
fn map_error(e: Error, sid: &str, name: &str) -> Error {
    let reason = e.extra.get("reason").and_then(Value::as_str).unwrap_or("").to_string();
    let message = match (e.code.as_str(), reason.as_str()) {
        ("session_not_found", _) => format!("no session {sid} that you can see"),
        ("secret_not_found", _) => format!("{name} is not set on {sid} (only the session's own secrets can be deleted here)"),
        ("forbidden", "missing_scope") => "this API key cannot change secrets: it needs the secrets:write scope, which * and sandbox:* keys do not include (opc login gets one)".into(),
        // The API names who set it: only they or an organization admin may replace or delete it.
        ("forbidden", "not_secret_owner") => format!("{name} on {sid} was set by someone else: {}", e.message),
        ("forbidden", "computer_principal") => "a session's own key cannot read or set secrets: run this from your own machine".into(),
        ("forbidden", _) => format!("you may not change the secrets of {sid}"),
        ("feature_unavailable", _) => "this server cannot set session secrets yet".into(),
        ("invalid_name", _) => format!("cannot use {name}: {}", e.message.trim_start_matches("Can't use this name: ")),
        ("too_large", _) => format!("the value is longer than {} KB", MAX_VALUE / 1024),
        _ => return e,
    };
    Error { message, ..e }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_follow_the_api() {
        for ok in ["A", "_X", "AWS_SECRET_ACCESS_KEY", &"A".repeat(64)] {
            assert!(check_name(ok).is_ok(), "{ok}");
        }
        for bad in ["", "9A", "A-B", "A B", "É", &"A".repeat(65)] {
            assert!(check_name(bad).is_err(), "{bad}");
        }
    }

    #[test]
    fn a_row_never_has_a_value() {
        let row = json!({"name": "TOKEN", "scope": "session", "kind": "secret", "file": true, "value": "dummy-value",
            "setBy": {"id": "usr_1", "name": "Test User", "via": "opc", "client": null}, "updatedAt": "2026-11-26T00:00:00.000Z"});
        let l = line(&row);
        assert!(l.starts_with("TOKEN"));
        assert!(l.contains("secret, file") && l.contains("set by Test User via opc"));
        assert!(!l.contains("dummy-value"));
    }

    #[test]
    fn refusals_read_as_this_command() {
        let e = map_error(Error::from_api(403, &json!({"code": "forbidden", "message": "m", "reason": "missing_scope", "scope": "secrets:write"})), "cs_1", "X");
        assert!(e.message.contains("secrets:write"));
        assert_eq!(e.exit_code(), crate::error::exit::AUTH);
        let e = map_error(Error::from_api(404, &json!({"code": "session_not_found", "message": "No such session."})), "cs_1", "X");
        assert_eq!(e.message, "no session cs_1 that you can see");
        let e = map_error(Error::from_api(409, &json!({"code": "feature_unavailable", "message": "m"})), "cs_1", "X");
        assert!(e.message.contains("cannot set session secrets"));
        let m = "Only the person who set X (Test User) or an organization admin can replace or delete it.";
        let e = map_error(Error::from_api(403, &json!({"code": "forbidden", "message": m, "reason": "not_secret_owner"})), "cs_1", "X");
        assert_eq!(e.message, format!("X on cs_1 was set by someone else: {m}"));
        assert_eq!(e.exit_code(), crate::error::exit::AUTH);
    }
}
