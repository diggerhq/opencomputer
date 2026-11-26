//! Slash commands: what a line that starts with `/` means.

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Line {
    /// A message for the agent (`//x` sends `/x`).
    Message(String),
    Command(Cmd),
    /// Not a command opc knows: refused, never sent.
    Unknown(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Cmd {
    Help,
    Model(Option<String>),
    Effort(Option<String>),
    Speed(Option<String>),
    Mode(Option<String>),
    Title(String),
    Queue(String),
    Interrupt,
    Compact(Option<String>),
    Allowed,
    Push { dir: String, to: Option<String> },
    Pull { path: String, dir: Option<String> },
    Diff { stat: bool },
    Shell,
    Sessions,
    New,
    Detach,
    Suspend,
    Archive,
    Web,
    Copy { code: bool },
    Details,
    Subagents(Option<usize>),
    Timing,
    Id,
}

/// Every command, for `/help` and `Tab`.
pub const COMMANDS: &[(&str, &str)] = &[
    ("/help", "lists these commands"),
    ("/model", "shows or sets the model"),
    ("/effort", "shows or sets the effort level"),
    ("/speed", "shows or sets the speed: fast or standard"),
    ("/mode", "shows or sets the permission mode"),
    ("/title", "renames the session (also /rename)"),
    ("/queue", "sends a message as its own turn, after the running one"),
    ("/interrupt", "same as Esc (also /stop)"),
    ("/compact", "summarizes the conversation to free context"),
    ("/allowed", "lists the rules allowed for this session"),
    ("/push", "copies a local directory into the workspace"),
    ("/pull", "copies a directory from the workspace here"),
    ("/diff", "the workspace's git diff, through $PAGER"),
    ("/shell", "opens a shell in the workspace; exit returns here"),
    ("/sessions", "lists your sessions, to pick one to attach"),
    ("/new", "detaches and starts a new session"),
    ("/detach", "detaches (Ctrl+D)"),
    ("/suspend", "suspends the session now"),
    ("/archive", "archives the session and detaches"),
    ("/web", "opens the session on the dashboard"),
    ("/copy", "copies the agent's last message; /copy code its last code block"),
    ("/details", "pipes the details through $PAGER (Ctrl+O)"),
    ("/subagents", "lists subagents; /subagents 2 opens the second"),
    ("/timing", "prints the timings of this launch and the last turn"),
    ("/id", "prints the session's id and links"),
];

fn opt(rest: &str) -> Option<String> {
    let r = rest.trim();
    (!r.is_empty()).then(|| r.to_string())
}

/// Splits on whitespace, keeping `"quoted words"` together.
fn words(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote = None;
    let mut any = false;
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (None, '"' | '\'') => {
                quote = Some(c);
                any = true;
            }
            (None, c) if c.is_whitespace() => {
                if any {
                    out.push(std::mem::take(&mut cur));
                    any = false;
                }
            }
            (_, c) => {
                cur.push(c);
                any = true;
            }
        }
    }
    if any {
        out.push(cur);
    }
    out
}

pub fn parse(line: &str) -> Line {
    if let Some(rest) = line.strip_prefix("//") {
        return Line::Message(format!("/{rest}"));
    }
    let Some(body) = line.strip_prefix('/') else { return Line::Message(line.to_string()) };
    let (name, rest) = match body.find(char::is_whitespace) {
        Some(i) => (&body[..i], &body[i..]),
        None => (body, ""),
    };
    let cmd = match name.to_ascii_lowercase().as_str() {
        "help" | "?" => Cmd::Help,
        "model" => Cmd::Model(opt(rest)),
        "effort" => Cmd::Effort(opt(rest)),
        "speed" => Cmd::Speed(opt(rest)),
        "mode" => Cmd::Mode(opt(rest)),
        "title" | "rename" => match opt(rest) {
            Some(t) => Cmd::Title(t),
            None => return Line::Unknown("/title needs the new title: /title <words>".into()),
        },
        "queue" => match rest.strip_prefix(char::is_whitespace).filter(|r| !r.trim().is_empty()) {
            Some(m) => Cmd::Queue(m.to_string()),
            None => return Line::Unknown("/queue needs a message: /queue <message>".into()),
        },
        "interrupt" | "stop" => Cmd::Interrupt,
        "compact" => Cmd::Compact(opt(rest)),
        "allowed" => Cmd::Allowed,
        "push" => {
            let w = words(rest);
            let mut dir = None;
            let mut to = None;
            let mut i = 0;
            while i < w.len() {
                if w[i] == "--to" {
                    to = w.get(i + 1).cloned();
                    i += 2;
                    continue;
                }
                if let Some(t) = w[i].strip_prefix("--to=") {
                    to = Some(t.to_string());
                } else if dir.is_none() {
                    dir = Some(w[i].clone());
                }
                i += 1;
            }
            match dir {
                Some(dir) => Cmd::Push { dir, to },
                None => return Line::Unknown("/push needs a directory: /push <dir> [--to <name>]".into()),
            }
        }
        "pull" => {
            let w = words(rest);
            match w.first() {
                Some(p) => Cmd::Pull { path: p.clone(), dir: w.get(1).cloned() },
                None => return Line::Unknown("/pull needs a path: /pull <path> [dir]".into()),
            }
        }
        "diff" => Cmd::Diff { stat: rest.contains("--stat") },
        "shell" => Cmd::Shell,
        "sessions" => Cmd::Sessions,
        "new" => Cmd::New,
        "detach" | "exit" | "quit" => Cmd::Detach,
        "suspend" => Cmd::Suspend,
        "archive" => Cmd::Archive,
        "web" => Cmd::Web,
        "copy" => Cmd::Copy { code: rest.trim() == "code" },
        "details" => Cmd::Details,
        "subagents" => Cmd::Subagents(rest.trim().parse::<usize>().ok().filter(|n| *n > 0)),
        "timing" => Cmd::Timing,
        "id" => Cmd::Id,
        _ => {
            let shown = line.split_whitespace().next().unwrap_or(line);
            return Line::Unknown(format!("unknown command {shown}. To send it to the agent, type /{shown}"));
        }
    };
    Line::Command(cmd)
}

/// `Tab` on a command name: the completion, or the candidates.
pub fn complete(line: &str) -> Result<String, Vec<&'static str>> {
    if !line.starts_with('/') || line.contains(char::is_whitespace) || line.starts_with("//") {
        return Err(vec![]);
    }
    let mut c: Vec<&'static str> = COMMANDS.iter().map(|(n, _)| *n).filter(|n| n.starts_with(line)).collect();
    c.sort_unstable();
    match c.len() {
        1 => Ok(format!("{} ", c[0])),
        0 => Err(vec![]),
        _ => {
            let mut p = c[0].to_string();
            for x in &c[1..] {
                while !x.starts_with(&p) {
                    p.pop();
                }
            }
            if p.len() > line.len() { Ok(p) } else { Err(c) }
        }
    }
}

/// A setting's value from what was typed: exact, else the one value that
/// starts with it or contains it, case-insensitively.
pub fn match_value<'a>(typed: &str, values: &'a [(String, String)]) -> Result<&'a str, String> {
    let t = typed.trim().to_lowercase();
    let norm = |s: &str| s.to_lowercase().replace([' ', '-', '.'], "");
    let tn = norm(&t);
    if let Some((id, _)) = values.iter().find(|(id, name)| id.to_lowercase() == t || name.to_lowercase() == t) {
        return Ok(id);
    }
    let pre: Vec<&(String, String)> = values.iter().filter(|(id, name)| name.to_lowercase().starts_with(&t) || norm(id).contains(&tn) || norm(name).starts_with(&tn)).collect();
    match pre.len() {
        1 => Ok(&pre[0].0),
        _ => {
            let all: Vec<&str> = values.iter().map(|(_, n)| n.as_str()).collect();
            Err(if pre.is_empty() { format!("not allowed here; choose one of: {}", all.join(", ")) } else { format!("\"{typed}\" matches several: {}", pre.iter().map(|x| x.1.as_str()).collect::<Vec<_>>().join(", ")) })
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_commands_and_escapes() {
        assert_eq!(parse("hello"), Line::Message("hello".into()));
        assert_eq!(parse("//etc/hosts is wrong"), Line::Message("/etc/hosts is wrong".into()));
        assert_eq!(parse("!ls"), Line::Message("!ls".into()));
        assert_eq!(parse("/model sonnet 5.5"), Line::Command(Cmd::Model(Some("sonnet 5.5".into()))));
        assert_eq!(parse("/queue then run it"), Line::Command(Cmd::Queue("then run it".into())));
        assert_eq!(parse("/push ~/src/billing --to bill"), Line::Command(Cmd::Push { dir: "~/src/billing".into(), to: Some("bill".into()) }));
        assert_eq!(parse("/subagents 2"), Line::Command(Cmd::Subagents(Some(2))));
        assert_eq!(parse("/stop"), Line::Command(Cmd::Interrupt));
        assert_eq!(parse("/speed standard"), Line::Command(Cmd::Speed(Some("standard".into()))));
        assert_eq!(parse("/speed"), Line::Command(Cmd::Speed(None)));
        assert_eq!(parse("/deploy now"), Line::Unknown("unknown command /deploy. To send it to the agent, type //deploy".into()));
    }

    #[test]
    fn completes_names() {
        assert_eq!(complete("/su"), Err(vec!["/subagents", "/suspend"]));
        assert_eq!(complete("/subag"), Ok("/subagents ".into()));
        assert_eq!(complete("/det"), Ok("/deta".into()));
    }

    #[test]
    fn matches_values_by_prefix() {
        let v = vec![("claude-opus-5-5".to_string(), "Opus 5.5".to_string()), ("claude-sonnet-5-5".to_string(), "Sonnet 5.5".to_string())];
        assert_eq!(match_value("son", &v), Ok("claude-sonnet-5-5"));
        assert_eq!(match_value("sonnet 5.5", &v), Ok("claude-sonnet-5-5"));
        assert!(match_value("haiku", &v).is_err());
    }
}
