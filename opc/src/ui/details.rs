//! The details: every recorded event in full, piped through `$PAGER`
//! (`Ctrl+O`, `/details`). Nothing here draws full-screen itself: the pager
//! is the person's own program, and the session screen comes back as it was
//! when it quits.

use std::collections::HashMap;
use std::io::Write;

use serde_json::Value;

use super::clean;
use crate::api::types::{Ask, Event, Subagent};

fn s<'a>(v: &'a Value, k: &str) -> Option<&'a str> {
    v.get(k).and_then(Value::as_str)
}

fn indent(text: &str, by: usize) -> String {
    let pad = " ".repeat(by);
    clean(text).lines().map(|l| format!("{pad}{l}")).collect::<Vec<_>>().join("\n")
}

fn pretty(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => String::new(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// A tool's input for people: the command, the file and its diff, else
/// the JSON.
fn tool_input(tool: &str, input: &Value) -> String {
    match tool {
        "Bash" => {
            let mut out = String::new();
            if let Some(d) = s(input, "description") {
                out.push_str(&format!("# {d}\n"));
            }
            out.push_str(&format!("$ {}", s(input, "command").unwrap_or("")));
            out
        }
        "Edit" | "MultiEdit" => {
            let mut out = format!("{}\n", s(input, "file_path").unwrap_or(""));
            let edits: Vec<&Value> = match input.get("edits").and_then(Value::as_array) {
                Some(a) => a.iter().collect(),
                None => vec![input],
            };
            for e in edits {
                for l in s(e, "old_string").unwrap_or("").lines() {
                    out.push_str(&format!("- {l}\n"));
                }
                for l in s(e, "new_string").unwrap_or("").lines() {
                    out.push_str(&format!("+ {l}\n"));
                }
            }
            out
        }
        "Write" => format!("{}\n{}", s(input, "file_path").unwrap_or(""), s(input, "content").unwrap_or("")),
        _ => pretty(input),
    }
}

/// The text of the details, for the pager. `only` limits it to one
/// subagent's calls (`/subagents`, `Enter` on a running one).
pub fn render(events: &[Event], subs: &[Subagent], asks: &[Ask], only: Option<&str>) -> String {
    let mut out = String::new();
    let rule = "─".repeat(60);
    // Tool names by call, for the ending events.
    let mut tools: HashMap<String, String> = HashMap::new();
    // Nesting: the subagent of each parent call.
    let sub_of_call: HashMap<String, &Subagent> = subs.iter().filter_map(|x| x.call_id.clone().map(|c| (c, x))).collect();
    let mut turn = String::new();
    for ev in events {
        let d = ev.data();
        let in_sub = s(d, "subagentId").map(str::to_string);
        if let Some(only) = only
            && in_sub.as_deref() != Some(only)
            && !(ev.kind() == "subagent.ended" || ev.kind() == "subagent.started")
        {
            continue;
        }
        let pad = if in_sub.is_some() || s(d, "parentCallId").is_some() { 4 } else { 0 };
        let p = " ".repeat(pad);
        let tid = ev.turn_id().unwrap_or("");
        if only.is_none() && !tid.is_empty() && tid != turn && in_sub.is_none() {
            turn = tid.to_string();
            out.push_str(&format!("\n{rule}\nturn {tid}\n"));
        }
        let at = ev.created_at().unwrap_or("");
        match ev.kind() {
            "message.received" => {
                let who = ev.actor().map(|a| if a.name.is_empty() { "someone".to_string() } else { a.name }).unwrap_or_else(|| "you".into());
                out.push_str(&format!("\n{who} ({}) {at}\n{}\n", s(d, "delivery").unwrap_or(""), indent(s(d, "input").unwrap_or(""), 2)));
            }
            "turn.started" => {
                let mut l = format!("started {at}");
                for k in ["model", "effort", "speed", "mode", "trigger"] {
                    if let Some(v) = s(d, k) {
                        l.push_str(&format!(" · {k} {v}"));
                    }
                }
                out.push_str(&format!("{l}\n"));
            }
            "reasoning.completed" => {
                let text = s(d, "text").unwrap_or("");
                if d.get("redacted").and_then(Value::as_bool) == Some(true) || text.is_empty() {
                    out.push_str(&format!("{p}(reasoning, not readable)\n"));
                } else {
                    out.push_str(&format!("{p}reasoning:\n{}\n", indent(text, pad + 2)));
                }
            }
            "message.completed" => {
                out.push_str(&format!("\n{}\n", indent(s(d, "text").unwrap_or(""), pad + 2)));
            }
            "tool.started" => {
                let tool = s(d, "toolName").or(s(d, "name")).unwrap_or("tool").to_string();
                let call = s(d, "callId").unwrap_or("").to_string();
                tools.insert(call.clone(), tool.clone());
                out.push_str(&format!("\n{p}▸ {tool}  {}\n", clean(s(d, "title").unwrap_or(""))));
                let input = tool_input(&tool, d.get("input").unwrap_or(&Value::Null));
                if !input.trim().is_empty() {
                    out.push_str(&format!("{}\n", indent(&input, pad + 4)));
                }
                if d.get("inputTruncated").and_then(Value::as_bool) == Some(true) {
                    out.push_str(&format!("{p}    (input truncated)\n"));
                }
                if let Some(sa) = sub_of_call.get(&call) {
                    out.push_str(&format!("{p}    subagent {} · {}\n", sa.id, clean(&sa.name)));
                }
            }
            "tool.completed" | "tool.failed" => {
                let call = s(d, "callId").unwrap_or("");
                let tool = tools.get(call).cloned().or(s(d, "toolName").map(str::to_string)).unwrap_or_else(|| "tool".into());
                let ms = d.get("durationMs").and_then(Value::as_u64).map(|m| format!(" · {}", super::dur(m))).unwrap_or_default();
                if ev.kind() == "tool.failed" {
                    let why = s(d, "message").or(s(d, "settledBy")).unwrap_or("");
                    out.push_str(&format!("{p}  ✗ {tool} failed{ms}: {}\n", clean(why)));
                } else {
                    out.push_str(&format!("{p}  ✓ {tool}{ms}\n"));
                    let o = pretty(d.get("output").unwrap_or(&Value::Null));
                    if !o.trim().is_empty() {
                        out.push_str(&format!("{}\n", indent(&o, pad + 4)));
                    }
                    if d.get("outputTruncated").and_then(Value::as_bool) == Some(true) {
                        out.push_str(&format!("{p}    (output truncated)\n"));
                    }
                }
            }
            "ask.opened" | "ask.closed" => {
                if let Some(a) = d.get("ask").and_then(|a| serde_json::from_value::<Ask>(a.clone()).ok()) {
                    out.push_str(&format!("{p}ask {} {} · {} · {}\n", a.id, if ev.kind() == "ask.opened" { "opened" } else { "closed" }, a.kind, clean(&a.describe())));
                    if let Some(ap) = &a.approval
                        && ev.kind() == "ask.opened"
                    {
                        let input = if ap.tool_name == "ExitPlanMode" { s(&ap.input, "plan").unwrap_or("").to_string() } else { tool_input(&ap.tool_name, &ap.input) };
                        out.push_str(&format!("{}\n", indent(&input, pad + 4)));
                    }
                    if let Some(ans) = &a.answer {
                        out.push_str(&format!("{p}    answer: {}\n", clean(&ans.to_string())));
                    }
                }
            }
            "subagent.started" | "subagent.ended" => {
                if let Some(sa) = d.get("subagent") {
                    let name = clean(s(sa, "name").unwrap_or(""));
                    out.push_str(&format!("\nsubagent {} \"{name}\" {} · {}\n", s(sa, "id").unwrap_or(""), if ev.kind() == "subagent.started" { "started" } else { "ended" }, s(sa, "status").unwrap_or("")));
                    if let Some(r) = s(sa, "result") {
                        out.push_str(&format!("  result:\n{}\n", indent(r, 4)));
                    }
                }
            }
            "turn.completed" | "turn.failed" | "turn.cancelled" => {
                let mut l = format!("{} {at}", ev.kind().trim_start_matches("turn."));
                if let Some(r) = s(d, "reason") {
                    l.push_str(&format!(" · {r}"));
                }
                if let Some(e) = d.get("error").filter(|e| !e.is_null()) {
                    l.push_str(&format!(" · {}", clean(&e.get("message").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| e.to_string()))));
                }
                out.push_str(&format!("{l}\n"));
            }
            "session.updated" | "session.compacted" | "files.pushed" | "runtime.suspended" => {
                out.push_str(&format!("{} {}\n", ev.kind(), clean(&d.to_string())));
            }
            _ => {}
        }
    }
    let open: Vec<&Ask> = asks.iter().filter(|a| a.is_open()).collect();
    if !open.is_empty() && only.is_none() {
        out.push_str(&format!("\n{rule}\nopen asks\n"));
        for a in open {
            out.push_str(&format!("  {} · {} · {}\n", a.id, a.kind, clean(&a.describe())));
            if let Some(ap) = &a.approval {
                let input = if ap.tool_name == "ExitPlanMode" { s(&ap.input, "plan").unwrap_or("").to_string() } else { tool_input(&ap.tool_name, &ap.input) };
                out.push_str(&format!("{}\n", indent(&input, 4)));
            }
        }
    }
    if out.trim().is_empty() {
        out.push_str("nothing yet\n");
    }
    out.trim_start_matches('\n').to_string()
}

/// Pipes `text` through `$PAGER` (`less -R` when unset). The terminal is
/// handed over and taken back. Without a pager, nothing is shown.
pub fn page(text: &str) -> std::io::Result<()> {
    let pager = std::env::var("PAGER").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "less -R".into());
    super::term::handed_over(|| {
        let mut out = std::io::stdout();
        let _ = out.write_all(b"\r\n");
        let _ = out.flush();
        let mut child = std::process::Command::new("sh").arg("-c").arg(&pager).stdin(std::process::Stdio::piped()).env("LESS", std::env::var("LESS").unwrap_or_else(|_| "FRX".into())).spawn()?;
        if let Some(mut stdin) = child.stdin.take() {
            let _ = stdin.write_all(text.as_bytes());
        }
        child.wait().map(|_| ())
    })
}

/// Opens `$VISUAL` or `$EDITOR` (`vi` when unset) on `text` and returns what
/// was saved. The draft is private (0700 directory, 0600 file); an editor
/// that exits with an error (`:cq`) leaves the message as it was.
pub fn edit(text: &str) -> std::io::Result<String> {
    let editor = std::env::var("VISUAL").ok().filter(|p| !p.trim().is_empty()).or_else(|| std::env::var("EDITOR").ok().filter(|p| !p.trim().is_empty())).unwrap_or_else(|| "vi".into());
    let dir = std::env::temp_dir().join(format!("opc-{}-{}", std::process::id(), crate::ids::random_base32(8)));
    let path = dir.join("message.md");
    crate::config::write_private(&path, text.as_bytes()).map_err(|e| std::io::Error::other(e.message))?;
    let status = super::term::handed_over(|| std::process::Command::new("sh").arg("-c").arg(format!("{editor} \"$1\"")).arg("sh").arg(&path).status());
    let r = match status {
        Ok(s) if s.success() => std::fs::read_to_string(&path),
        Ok(s) => Err(std::io::Error::other(format!("exited with {}; the message is unchanged", s.code().map_or("a signal".into(), |c| format!("status {c}"))))),
        Err(e) => Err(e),
    };
    let _ = std::fs::remove_dir_all(&dir);
    r.map(|s| s.trim_end_matches('\n').to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ev(seq: u64, kind: &str, data: Value) -> Event {
        Event(json!({"seq": seq, "type": kind, "sessionId": "ses_1", "turnId": "tn_1", "data": data, "createdAt": "2026-10-26T00:00:00Z"}))
    }

    #[test]
    fn details_have_full_inputs_outputs_and_reasoning() {
        let events = vec![
            ev(1, "message.received", json!({"input": "fix it", "delivery": "started"})),
            ev(2, "reasoning.completed", json!({"text": "The timer runs first.", "blockId": "b1"})),
            ev(3, "tool.started", json!({"toolName": "Bash", "callId": "c1", "input": {"command": "npm test", "description": "Run the tests"}})),
            ev(4, "tool.completed", json!({"toolName": "Bash", "callId": "c1", "output": "3 passing\n1 failing", "durationMs": 4100})),
            ev(5, "tool.started", json!({"toolName": "Edit", "callId": "c2", "input": {"file_path": "a.ts", "old_string": "x", "new_string": "y"}})),
            ev(6, "tool.failed", json!({"toolName": "Edit", "callId": "c2", "message": "no match", "settledBy": null})),
            ev(7, "turn.completed", json!({})),
        ];
        let t = render(&events, &[], &[], None);
        for want in ["fix it", "The timer runs first.", "$ npm test", "1 failing", "- x", "+ y", "✗ Edit failed: no match", "completed"] {
            assert!(t.contains(want), "missing {want:?} in\n{t}");
        }
    }

    #[test]
    fn odd_data_does_not_panic() {
        let events = vec![Event(json!({"type": "tool.completed", "data": 7})), Event(json!(null)), ev(1, "ask.opened", json!({"ask": "x"}))];
        let _ = render(&events, &[], &[], None);
        let _ = render(&events, &[], &[], Some("sa_1"));
    }
}
