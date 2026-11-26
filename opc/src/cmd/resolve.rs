//! Turning what people type into a session id: a full id, a prefix, `-`
//! (the last session), a Slack thread link, or words matched against titles.

use super::Ctx;
use crate::api::types::Session;
use crate::cache;
use crate::error::{Error, Result};
use crate::ids;
use serde_json::Value;

/// How far prefix and Slack-link lookups page through sessions.
const SCAN_LIMIT: usize = 500;

/// A resolved session: its id, and the session when a request returned it.
#[derive(Debug, Clone)]
pub struct Resolved {
    pub id: String,
    pub session: Option<Session>,
}

/// The session operand from a positional and `-s` (they must not both be
/// given), defaulting to the last session when `default_last`.
pub fn operand(positional: Option<&str>, flag: Option<&str>) -> Result<Option<String>> {
    match (positional, flag) {
        (Some(_), Some(_)) => Err(Error::usage("give the session once: as an argument or with -s")),
        (Some(p), None) => Ok(Some(p.to_string())),
        (None, Some(f)) => Ok(Some(f.to_string())),
        (None, None) => Ok(None),
    }
}

/// The session for a command that defaults to the last one. Commands that
/// change a workspace (`push`, `pull`, `shell`) pass `strict`: they use
/// the last session only when a person is at the terminal.
pub async fn session_or_last(ctx: &Ctx, target: Option<&str>, strict: bool) -> Result<Resolved> {
    match target {
        Some(t) => resolve(ctx, t).await,
        None if strict && !ctx.tty.stdin => Err(Error::usage("which session? pass -s <id> (the last session is used only at a terminal)")),
        None => resolve(ctx, "-").await,
    }
}

/// Resolves one target.
pub async fn resolve(ctx: &Ctx, target: &str) -> Result<Resolved> {
    let t = target.trim();
    if t.is_empty() {
        return Err(Error::usage("the session is empty"));
    }
    if t == "-" {
        return last(ctx).await;
    }
    if ids::is_session_id(t) {
        return Ok(Resolved { id: t.to_string(), session: None });
    }
    if let Some(turn) = t.strip_prefix("tn_").map(|_| t) {
        if let Some(s) = cache::session_for_turn(turn) {
            return Ok(Resolved { id: s, session: None });
        }
        return Err(Error::usage(format!("{turn} is a turn: pass its session with -s")));
    }
    if let Some((channel, thread)) = ids::parse_slack_link(t) {
        return slack(ctx, &channel, &thread, t).await;
    }
    if let Some(prefix) = ids::session_prefix(t)
        && !t.contains(' ') {
            match by_prefix(ctx, prefix).await? {
                Some(r) => return Ok(r),
                // A word made only of base32 letters ("deploy") can also be
                // a title word: fall through to the search unless it had
                // `cs_`.
                None if t.starts_with("cs_") => {
                    return Err(Error::new("session_not_found", format!("no session starts with {t}")));
                }
                None => {}
            }
        }
    words(ctx, t).await
}

/// `-`: the last session opc used, else the most recently active one.
async fn last(ctx: &Ctx) -> Result<Resolved> {
    if let Some(id) = cache::load_state().last_session {
        return Ok(Resolved { id, session: None });
    }
    let page = list(ctx, &[("owner", "me"), ("order", "active"), ("limit", "1")], None).await?;
    match page.0.into_iter().next() {
        Some(s) => Ok(Resolved { id: s.id.clone(), session: Some(s) }),
        None => Err(Error::new("session_not_found", "you have no sessions yet: start one with opc \"<message>\"")),
    }
}

/// One page of `GET /sessions`.
pub async fn list(ctx: &Ctx, query: &[(&str, &str)], cursor: Option<&str>) -> Result<(Vec<Session>, Option<String>)> {
    let mut q = crate::http::q(query);
    if let Some(c) = cursor {
        q.push(("cursor".into(), c.into()));
    }
    let v = ctx.http.get("/sessions", &q).await?;
    let sessions: Vec<Session> = serde_json::from_value(v.get("sessions").cloned().unwrap_or(Value::Array(vec![])))?;
    let next = v.get("nextCursor").and_then(Value::as_str).map(str::to_string);
    Ok((sessions, next))
}

/// Pages through sessions until `pick` returns something or the scan limit.
async fn scan(ctx: &Ctx, query: &[(&str, &str)], mut keep: impl FnMut(&Session) -> bool) -> Result<Vec<Session>> {
    let mut found = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = 0usize;
    loop {
        let (page, next) = list(ctx, query, cursor.as_deref()).await?;
        seen += page.len();
        for s in page {
            if keep(&s) {
                found.push(s);
            }
        }
        match next {
            Some(n) if seen < SCAN_LIMIT => cursor = Some(n),
            _ => return Ok(found),
        }
    }
}

async fn by_prefix(ctx: &Ctx, prefix: &str) -> Result<Option<Resolved>> {
    let lower = prefix.to_ascii_lowercase();
    let starts = |s: &Session| s.id.strip_prefix("cs_").is_some_and(|b| b.starts_with(&lower));
    let cached: Vec<Session> = cache::sessions(&ctx.config.api_url).into_iter().filter(|s| starts(s)).collect();
    if cached.len() == 1 {
        let s = cached.into_iter().next().unwrap();
        return Ok(Some(Resolved { id: s.id.clone(), session: None }));
    }
    let found = scan(ctx, &[("owner", "anyone"), ("archived", "all"), ("order", "active"), ("limit", "100")], starts).await?;
    one_of(found, &format!("cs_{lower}"))
}

async fn slack(ctx: &Ctx, channel: &str, thread: &str, link: &str) -> Result<Resolved> {
    let found = scan(ctx, &[("owner", "anyone"), ("origin", "slack"), ("archived", "all"), ("order", "active"), ("limit", "100")], |s| {
        let o = s.origin.get("slack").unwrap_or(&s.origin);
        o.get("channelId").and_then(Value::as_str) == Some(channel) && o.get("threadTs").and_then(Value::as_str) == Some(thread)
    })
    .await?;
    one_of(found, link)?.ok_or_else(|| Error::new("session_not_found", format!("no session for the Slack thread {link}")))
}

async fn words(ctx: &Ctx, text: &str) -> Result<Resolved> {
    let (found, _) = list(ctx, &[("owner", "me"), ("q", text), ("order", "active"), ("limit", "20")], None).await?;
    one_of(found, &format!("\"{text}\""))?
        .ok_or_else(|| Error::new("session_not_found", format!("no session of yours matches \"{text}\"")).hint("list them with: opc ls"))
}

fn one_of(found: Vec<Session>, what: &str) -> Result<Option<Resolved>> {
    match found.len() {
        0 => Ok(None),
        1 => {
            let s = found.into_iter().next().unwrap();
            Ok(Some(Resolved { id: s.id.clone(), session: Some(s) }))
        }
        n => {
            let lines: Vec<String> = found.iter().take(10).map(|s| format!("  {}  {}", s.id, s.title)).collect();
            Err(Error::new("session_ambiguous", format!("{what} matches {n} sessions"))
                .with("matches", found.iter().map(|s| s.id.clone()).collect::<Vec<_>>())
                .hint(format!("{}\npass more of the id", lines.join("\n"))))
        }
    }
}
