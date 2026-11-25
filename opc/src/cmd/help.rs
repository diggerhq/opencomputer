//! `opc schema`, `opc help` and `opc completion`: offline, no credential.

use super::println_out;
use crate::cli::{Cli, CompletionArgs, CompletionShell, HelpArgs, SchemaArgs};
use crate::error::{Error, Result, exit};
use clap::CommandFactory;
use serde_json::{Value, json};

/// The schema published at `https://raw.githubusercontent.com/diggerhq/opc/main/schema/computer-api.v1.json`.
pub const SCHEMA: &str = include_str!("../../schema/computer-api.v1.json");

const OBJECTS: &[(&str, &str)] = &[("result", "Result"), ("event", "Event"), ("session", "Session"), ("turn", "Turn"), ("ask", "Ask"), ("subagent", "Subagent"), ("error", "Error")];

pub fn schema(a: SchemaArgs) -> Result<i32> {
    let Some(object) = a.object else {
        println_out(SCHEMA.trim_end());
        return Ok(exit::OK);
    };
    let name = OBJECTS
        .iter()
        .find(|(k, _)| k.eq_ignore_ascii_case(&object))
        .map(|(_, v)| *v)
        .ok_or_else(|| Error::usage(format!("no object named {object}: one of {}", OBJECTS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", "))))?;
    let full: Value = serde_json::from_str(SCHEMA).map_err(|e| Error::new("internal", format!("the built-in schema is invalid: {e}")))?;
    let id = full.get("$id").and_then(Value::as_str).unwrap_or("");
    let one = json!({
        "$schema": full.get("$schema"),
        "$id": format!("{id}#/$defs/{name}"),
        "$ref": format!("#/$defs/{name}"),
        "$defs": full.get("$defs"),
    });
    println_out(&serde_json::to_string_pretty(&one).unwrap_or_default());
    Ok(exit::OK)
}

/// Pages of the docs readable in the terminal.
const TOPICS: &[(&str, &str)] = &[
    ("scripting", include_str!("../../docs/cli/scripting.mdx")),
    ("agents", include_str!("../../docs/cli/agents.mdx")),
    ("auth", include_str!("../../docs/cli/auth.mdx")),
    ("ci", include_str!("../../docs/cli/ci.mdx")),
    ("files", include_str!("../../docs/cli/files.mdx")),
    ("sessions", include_str!("../../docs/cli/sessions.mdx")),
    ("sharing", include_str!("../../docs/cli/sharing.mdx")),
    ("shell", include_str!("../../docs/cli/shell.mdx")),
    ("keys", include_str!("../../docs/terminal/keys.mdx")),
    ("slash-commands", include_str!("../../docs/terminal/slash-commands.mdx")),
    ("status-line", include_str!("../../docs/terminal/status-line.mdx")),
    ("exit-codes", include_str!("../../docs/reference/exit-codes.mdx")),
    ("environment", include_str!("../../docs/reference/environment.mdx")),
    ("timing", include_str!("../../docs/reference/timing.mdx")),
    ("telemetry", include_str!("../../docs/reference/telemetry.mdx")),
    ("troubleshooting", include_str!("../../docs/troubleshooting.mdx")),
];

pub fn help(a: HelpArgs) -> Result<i32> {
    let mut cmd = Cli::command();
    if a.topic.is_empty() {
        println_out(&cmd.render_long_help().to_string());
        println_out(&format!("Topics: opc help <topic>, one of {}", TOPICS.iter().map(|(k, _)| *k).collect::<Vec<_>>().join(", ")));
        return Ok(exit::OK);
    }
    let first = a.topic[0].to_ascii_lowercase();
    if let Some((_, page)) = TOPICS.iter().find(|(k, _)| *k == first) {
        println_out(&plain(page));
        return Ok(exit::OK);
    }
    // A command, possibly nested: `opc help ask allow`.
    cmd.build();
    let mut sub = &mut cmd;
    for word in &a.topic {
        sub = sub
            .find_subcommand_mut(word)
            .ok_or_else(|| Error::usage(format!("no command or topic named {}: opc help lists them", a.topic.join(" "))))?;
    }
    println_out(&sub.render_long_help().to_string());
    Ok(exit::OK)
}

/// A docs page as plain text: no front matter, no MDX tags, links as text.
pub fn plain(mdx: &str) -> String {
    let mut body = mdx;
    if let Some(rest) = body.strip_prefix("---\n")
        && let Some(end) = rest.find("\n---\n")
    {
        let front = &rest[..end];
        body = &rest[end + 5..];
        let title = front.lines().find_map(|l| l.strip_prefix("title:")).map(|t| t.trim().trim_matches('"').to_string());
        if let Some(t) = title {
            return format!("{t}\n{}\n{}", "=".repeat(t.chars().count()), plain_body(body));
        }
    }
    plain_body(body)
}

fn plain_body(body: &str) -> String {
    let mut out = Vec::new();
    let mut in_code = false;
    for line in body.lines() {
        let t = line.trim_start();
        if t.starts_with("```") {
            in_code = !in_code;
            continue;
        }
        if in_code {
            out.push(format!("    {line}"));
            continue;
        }
        // JSX tags on their own line: keep a title attribute, drop the rest.
        if t.starts_with('<') && !t.starts_with("<http") {
            if let Some(i) = t.find("title=\"") {
                let rest = &t[i + 7..];
                if let Some(j) = rest.find('"') {
                    out.push(format!("• {}", &rest[..j]));
                }
            }
            continue;
        }
        out.push(links(line));
    }
    let mut s = out.join("\n");
    while s.contains("\n\n\n") {
        s = s.replace("\n\n\n", "\n\n");
    }
    s.trim().to_string()
}

/// `[text](/path)` becomes `text`.
fn links(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('[') {
        let after = &rest[open + 1..];
        match after.find("](").and_then(|close| after[close + 2..].find(')').map(|end| (close, end))) {
            Some((close, end)) if !after[..close].contains('[') => {
                out.push_str(&rest[..open]);
                out.push_str(&after[..close]);
                rest = &after[close + 2 + end + 1..];
            }
            _ => {
                out.push_str(&rest[..=open]);
                rest = after;
            }
        }
    }
    out.push_str(rest);
    out
}

pub fn completion(a: CompletionArgs) -> Result<i32> {
    use clap_complete::{Shell, generate};
    let shell = match a.shell {
        CompletionShell::Bash => Shell::Bash,
        CompletionShell::Zsh => Shell::Zsh,
        CompletionShell::Fish => Shell::Fish,
    };
    generate(shell, &mut Cli::command(), "opc", &mut std::io::stdout());
    Ok(exit::OK)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn schema_parses_and_has_objects() {
        let v: Value = serde_json::from_str(SCHEMA).unwrap();
        for (_, name) in OBJECTS {
            assert!(v.pointer(&format!("/$defs/{name}")).is_some(), "{name}");
        }
    }

    #[test]
    fn mdx_to_text() {
        let page = "---\ntitle: \"Scripting\"\n---\n\nSee [Agents](/cli/agents) now.\n\n<Note>\nhi\n</Note>\n```bash\nopc -p x\n```\n";
        let t = plain(page);
        assert!(t.starts_with("Scripting\n========="));
        assert!(t.contains("See Agents now."));
        assert!(t.contains("    opc -p x"));
        assert!(!t.contains("<Note>"));
    }
}
