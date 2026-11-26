//! Events as plain lines, for `opc watch`, `opc log` and `opc -p`'s progress.
//! The interactive screen draws its own (`ui`).

use crate::api::types::{Ask, Event, Subagent};
use serde_json::Value;

/// How much to print.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Detail {
    /// One line per message, tool call and answer.
    Brief,
    /// Everything, as the session screen shows it with details open.
    Full,
}

pub struct Style {
    pub color: bool,
}

impl Style {
    fn paint(&self, code: &str, s: &str) -> String {
        if self.color { format!("\x1b[{code}m{s}\x1b[0m") } else { s.to_string() }
    }
    pub fn dim(&self, s: &str) -> String {
        self.paint("2", s)
    }
    pub fn bold(&self, s: &str) -> String {
        self.paint("1", s)
    }
    pub fn red(&self, s: &str) -> String {
        self.paint("31", s)
    }
    pub fn yellow(&self, s: &str) -> String {
        self.paint("33", s)
    }
    pub fn green(&self, s: &str) -> String {
        self.paint("32", s)
    }
}

/// Milliseconds as people read them: `850ms`, `12s`, `4m 2s`, `1h 3m`.
pub fn duration(ms: u64) -> String {
    let s = ms / 1000;
    if ms < 1000 {
        format!("{ms}ms")
    } else if s < 60 {
        format!("{s}s")
    } else if s < 3600 {
        format!("{}m {}s", s / 60, s % 60)
    } else {
        format!("{}h {}m", s / 3600, (s % 3600) / 60)
    }
}

/// `112.4k` tokens.
pub fn count(n: u64) -> String {
    if n >= 1_000_000 {
        format!("{:.1}M", n as f64 / 1e6)
    } else if n >= 10_000 {
        format!("{:.1}k", n as f64 / 1e3)
    } else {
        n.to_string()
    }
}

fn first_line(s: &str, max: usize) -> String {
    let line = s.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    truncate(line, max)
}

pub fn truncate(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        s.to_string()
    } else {
        let mut t: String = s.chars().take(max.saturating_sub(1)).collect();
        t.push('…');
        t
    }
}

fn indent(s: &str, by: &str) -> String {
    s.lines().map(|l| format!("{by}{l}")).collect::<Vec<_>>().join("\n")
}

/// A tool call's title: the event's `title`, else a Bash call's
/// description, else the tool's name.
pub fn tool_title(d: &Value) -> String {
    if let Some(t) = d.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        return t.to_string();
    }
    let name = d.get("toolName").and_then(Value::as_str).unwrap_or("tool");
    if let Some(desc) = d.pointer("/input/description").and_then(Value::as_str) {
        return format!("{name}: {desc}");
    }
    name.to_string()
}

/// One subagent as a line: `auth flow (Explore) · completed in 4m 2s · 41 tool calls · 112.4k tokens`.
pub fn subagent_line(sa: &Subagent) -> String {
    let mut out = sa.name.clone();
    if let Some(t) = &sa.agent_type {
        out.push_str(&format!(" ({t})"));
    }
    if sa.background {
        out.push_str(" · background");
    }
    match sa.status.as_str() {
        "running" => {
            if let Some(a) = &sa.activity {
                out.push_str(&format!(" · {a}"));
            }
        }
        s => {
            out.push_str(&format!(" · {s}"));
            if let Some(ms) = sa.duration_ms {
                out.push_str(&format!(" in {}", duration(ms)));
            }
        }
    }
    out.push_str(&format!(" · {} tool calls · {} tokens", sa.tool_calls, count(sa.tokens)));
    out
}

/// The lines for one recorded event, or none.
pub fn event_lines(e: &Event, detail: Detail, style: &Style) -> Option<String> {
    let d = e.data();
    let s = |k: &str| d.get(k).and_then(Value::as_str);
    let nested = d.get("parentCallId").is_some_and(|v| !v.is_null()) || d.get("subagentId").is_some_and(|v| !v.is_null());
    let pad = if nested { "    " } else { "  " };
    let full = detail == Detail::Full;
    match e.kind() {
        "message.received" => {
            let input = s("input")?;
            let who = e.actor().map(|a| a.name).filter(|n| !n.is_empty());
            let head = match who {
                Some(n) => format!("> {n}: "),
                None => "> ".to_string(),
            };
            let body = if full { input.to_string() } else { first_line(input, 200) };
            Some(style.bold(&format!("{head}{body}")))
        }
        "turn.started" => {
            if s("trigger") == Some("subagent") {
                let sa = s("subagentId").unwrap_or("a subagent");
                Some(style.dim(&format!("· the agent started a turn to read what {sa} found")))
            } else {
                None
            }
        }
        "message.completed" if !nested || full => {
            let text = s("text")?;
            Some(if nested { indent(text, pad) } else { text.to_string() })
        }
        "reasoning.completed" if full => s("text").map(|t| style.dim(&indent(t, "  ∴ "))),
        "tool.started" => {
            let line = format!("{pad}⏺ {}", tool_title(d));
            if full && let Some(input) = d.get("input").filter(|v| !v.is_null()) {
                let body = match input.get("command").and_then(Value::as_str) {
                    Some(c) => c.to_string(),
                    None => serde_json::to_string_pretty(input).unwrap_or_default(),
                };
                return Some(format!("{line}\n{}", style.dim(&indent(&body, &format!("{pad}  ")))));
            }
            Some(line)
        }
        "tool.completed" if full => {
            let out = match d.get("output") {
                Some(Value::String(t)) => t.clone(),
                Some(v) if !v.is_null() => serde_json::to_string_pretty(v).unwrap_or_default(),
                _ => return None,
            };
            let ms = d.get("durationMs").and_then(Value::as_u64).map(|m| format!(" ({})", duration(m))).unwrap_or_default();
            Some(style.dim(&format!("{pad}  ⎿ {}{ms}", indent(&out, &format!("{pad}    ")).trim_start())))
        }
        "tool.failed" => {
            let msg = s("message").unwrap_or("failed");
            Some(style.red(&format!("{pad}  ⎿ {}: {}", tool_title(d), first_line(msg, 200))))
        }
        "ask.opened" => {
            let ask: Ask = serde_json::from_value(d.get("ask")?.clone()).ok()?;
            Some(style.yellow(&format!("? waiting for a person: {} ({})", ask.describe(), ask.id)))
        }
        "ask.closed" => {
            let ask: Ask = serde_json::from_value(d.get("ask")?.clone()).ok()?;
            let by = e.actor().map(|a| format!(" by {}", a.name)).unwrap_or_default();
            Some(style.dim(&format!("  {} {}{by}", ask.id, ask.status)))
        }
        "subagent.started" => {
            let sa: Subagent = serde_json::from_value(d.get("subagent")?.clone()).ok()?;
            let kind = if sa.background { "background subagent" } else { "subagent" };
            let t = sa.agent_type.as_deref().map(|t| format!(" ({t})")).unwrap_or_default();
            Some(format!("  ⧉ {kind} {}{t} started", sa.name))
        }
        "subagent.ended" => {
            let sa: Subagent = serde_json::from_value(d.get("subagent")?.clone()).ok()?;
            let line = format!("  ⧉ {}", subagent_line(&sa));
            Some(if sa.status == "completed" { line } else { style.yellow(&line) })
        }
        "turn.completed" => {
            if d.get("silent").and_then(Value::as_bool) == Some(true) {
                Some(style.dim("  (no reply)"))
            } else if full {
                d.get("durationMs").and_then(Value::as_u64).map(|ms| style.dim(&format!("· done in {}", duration(ms))))
            } else {
                None
            }
        }
        "turn.failed" => {
            let msg = d.pointer("/error/message").and_then(Value::as_str).or_else(|| d.pointer("/error/code").and_then(Value::as_str)).unwrap_or("failed");
            Some(style.red(&format!("✗ the turn failed: {msg}")))
        }
        "turn.cancelled" => {
            let reason = s("reason").unwrap_or("cancelled");
            Some(style.yellow(&format!("⊘ the turn was cancelled ({reason})")))
        }
        "session.compacted" if full => Some(style.dim("· the conversation was summarized")),
        "files.pushed" => Some(style.dim(&format!(
            "· pushed {} files to {}",
            d.get("files").and_then(Value::as_u64).unwrap_or(0),
            s("path").unwrap_or(".")
        ))),
        "runtime.starting" if full => Some(style.dim("· starting")),
        "model.rate_limited" if full => Some(style.dim("· the model asked to wait")),
        _ => None,
    }
}

/// A short progress line for standard error while `opc -p` waits.
pub fn progress_line(e: &Event) -> Option<String> {
    let d = e.data();
    match e.kind() {
        "tool.started" => Some(format!("⏺ {}", tool_title(d))),
        "subagent.started" => d.pointer("/subagent/name").and_then(Value::as_str).map(|n| format!("⧉ subagent {n} started")),
        "subagent.ended" => {
            let sa: Subagent = serde_json::from_value(d.get("subagent")?.clone()).ok()?;
            Some(format!("⧉ {}", subagent_line(&sa)))
        }
        "turn.started" if d.get("trigger").and_then(Value::as_str) == Some("subagent") => {
            Some("the agent started a turn to read a subagent's result".to_string())
        }
        "runtime.starting" => Some(if d.get("phase").and_then(Value::as_str) == Some("computer") {
            "starting your computer…".to_string()
        } else {
            "starting the agent…".to_string()
        }),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn durations() {
        assert_eq!(duration(850), "850ms");
        assert_eq!(duration(12_000), "12s");
        assert_eq!(duration(242_538), "4m 2s");
        assert_eq!(count(112_400), "112.4k");
    }

    #[test]
    fn agent_started_turns_and_null_input() {
        let st = Style { color: false };
        let e = Event(json!({"seq": 9, "type": "turn.started", "sessionId": "cs_1", "turnId": "tn_1", "data": {"trigger": "subagent", "subagentId": "sa_3q8r1t6v7f3a"}}));
        assert!(event_lines(&e, Detail::Brief, &st).unwrap().contains("the agent started a turn"));
        let e = Event(json!({"seq": 10, "type": "message.received", "sessionId": "cs_1", "turnId": "tn_1", "data": {"input": null}}));
        assert!(event_lines(&e, Detail::Brief, &st).is_none());
        let e = Event(json!({"seq": 11, "type": "turn.completed", "sessionId": "cs_1", "turnId": "tn_1", "data": {"silent": true}}));
        assert_eq!(event_lines(&e, Detail::Brief, &st).unwrap(), "  (no reply)");
    }
}
