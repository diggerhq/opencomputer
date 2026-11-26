//! `opc ls`: your sessions, most recently active first.

use super::{Ctx, print_json, println_out};
use crate::api::types::Session;
use crate::cli::LsArgs;
use crate::error::Result;
use crate::render::{Style, truncate};
use serde_json::Value;
use unicode_width::UnicodeWidthStr;

pub async fn run(ctx: &mut Ctx, args: LsArgs) -> Result<i32> {
    ctx.require_key()?;
    let status = args.status.join(",");
    let meta: Vec<(String, String)> = args.metadata.iter().map(|(k, v)| (format!("metadata[{k}]"), v.clone())).collect();
    let limit = args.limit as usize;
    let mut out: Vec<Session> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let page = (limit - out.len()).min(100).to_string();
        let mut q: Vec<(&str, &str)> = vec![("owner", "me"), ("order", "active"), ("limit", &page), ("archived", if args.archived { "true" } else { "false" })];
        if !status.is_empty() {
            q.push(("status", &status));
        }
        for (k, v) in &meta {
            q.push((k, v));
        }
        let (sessions, next) = super::resolve::list(ctx, &q, cursor.as_deref()).await?;
        out.extend(sessions);
        match next {
            Some(n) if out.len() < limit => cursor = Some(n),
            _ => break,
        }
    }
    out.truncate(limit);
    if !args.archived && status.is_empty() && meta.is_empty() {
        crate::cache::save_sessions(ctx.http.api_url(), &out);
    }
    if args.json {
        print_json(ctx, &serde_json::to_value(&out)?);
        return Ok(0);
    }
    if out.is_empty() {
        ctx.progress("no sessions: start one with opc \"<message>\"");
        return Ok(0);
    }
    let style = Style { color: ctx.color };
    let ids: Vec<&str> = out.iter().map(|s| s.id.as_str()).collect();
    let now = time::OffsetDateTime::now_utc();
    let rows: Vec<[String; 5]> = out
        .iter()
        .map(|s| {
            [
                short_prefix(&s.id, &ids),
                truncate(&s.title, 40),
                status_label(s).to_string(),
                where_label(s),
                s.last_active_at.as_deref().and_then(crate::api::result::parse_time).map(|t| ago((now - t).whole_seconds())).unwrap_or_default(),
            ]
        })
        .collect();
    let head = ["ID", "TITLE", "STATUS", "WHERE", "ACTIVE"];
    let mut w = head.map(|h| h.width());
    for r in &rows {
        for (i, c) in r.iter().enumerate() {
            w[i] = w[i].max(c.width());
        }
    }
    let pad = |s: &str, n: usize| format!("{s}{}", " ".repeat(n.saturating_sub(s.width())));
    let line = |cells: &[String; 5]| (0..5).map(|i| pad(&cells[i], w[i])).collect::<Vec<_>>().join("  ").trim_end().to_string();
    println_out(&style.dim(&format!("   {}", line(&head.map(String::from)))));
    for (s, r) in out.iter().zip(&rows) {
        let mark = match s.status.as_str() {
            "waiting" => style.yellow("◆"),
            "running" | "starting" => style.green("●"),
            _ => " ".into(),
        };
        println_out(&format!(" {mark} {}", line(r)));
        if args.long
            && let Some(t) = s.last_text.as_deref().or(s.last_turn.as_ref().and_then(|l| l.text.as_deref()))
        {
            let first = t.lines().find(|l| !l.trim().is_empty()).unwrap_or("");
            println_out(&style.dim(&format!("       {}", truncate(first.trim(), 100))));
        }
    }
    Ok(0)
}

/// The shortest prefix (at least four characters) that no other listed id shares.
pub fn short_prefix(id: &str, all: &[&str]) -> String {
    let base = id.strip_prefix("cs_").unwrap_or(id);
    for n in 4..=base.len() {
        let p = &base[..n];
        if all.iter().filter(|o| o.strip_prefix("cs_").unwrap_or(o).starts_with(p)).count() <= 1 {
            return p.to_string();
        }
    }
    base.to_string()
}

fn status_label(s: &Session) -> &str {
    match s.status.as_str() {
        "waiting" => "waiting for you",
        other => other,
    }
}

fn where_label(s: &Session) -> String {
    let o = &s.origin;
    let slack = o.get("slack").unwrap_or(o);
    if let Some(c) = slack.get("channelName").and_then(Value::as_str) {
        return format!("#{c}");
    }
    match o.get("client").and_then(Value::as_str) {
        Some(c) if !c.is_empty() => c.split('/').next().unwrap_or(c).to_string(),
        _ => o.get("type").and_then(Value::as_str).unwrap_or("api").to_string(),
    }
}

pub fn ago(secs: i64) -> String {
    let s = secs.max(0);
    if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m", s / 60)
    } else if s < 86400 {
        format!("{}h", s / 3600)
    } else {
        format!("{}d", s / 86400)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prefixes() {
        let all = ["cs_7f3a9k2m4q8r1t6v", "cs_7f3b000000000000", "cs_9c1e000000000000"];
        assert_eq!(short_prefix(all[0], &all), "7f3a");
        assert_eq!(short_prefix(all[2], &all), "9c1e");
        assert_eq!(ago(130), "2m");
    }
}
