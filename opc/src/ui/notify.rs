//! Notifications, the terminal title and the clipboard: escape sequences
//! only, written by the app.

use base64::Engine;

/// How to tell the person something happened.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Notifier {
    Off,
    /// OSC 9 (iTerm2, WezTerm, Ghostty, Windows Terminal, kitty).
    Osc9,
    /// OSC 777 (VTE terminals, foot, urxvt).
    Osc777,
}

impl Notifier {
    pub fn from_env(env: impl Fn(&str) -> Option<String>) -> Notifier {
        if env("OPC_NOTIFY").is_some_and(|v| v.trim() == "0") {
            return Notifier::Off;
        }
        let term = env("TERM").unwrap_or_default();
        let prog = env("TERM_PROGRAM").unwrap_or_default().to_ascii_lowercase();
        if env("VTE_VERSION").is_some() || term.contains("rxvt") || term.starts_with("foot") || prog == "foot" {
            Notifier::Osc777
        } else {
            Notifier::Osc9
        }
    }

    /// What to write for `text`. `focused` is from focus events: `None`
    /// until the terminal reports one, and then only a bell is sent.
    pub fn sequence(self, text: &str, focused: Option<bool>) -> Option<String> {
        if self == Notifier::Off || focused == Some(true) {
            return None;
        }
        if focused.is_none() {
            return Some("\x07".into());
        }
        let t: String = super::clean(text).replace(['\n', ';'], " ").chars().take(200).collect();
        Some(match self {
            Notifier::Osc777 => format!("\x1b]777;notify;opc;{t}\x07"),
            _ => format!("\x1b]9;{t}\x07"),
        })
    }
}

/// Saves the terminal's title, to be put back by [`pop_title`].
pub fn push_title() -> &'static str {
    "\x1b[22;0t"
}

pub fn pop_title() -> &'static str {
    "\x1b[23;0t"
}

pub fn set_title(t: &str) -> String {
    let t: String = super::clean(t).replace('\n', " ").chars().take(120).collect();
    format!("\x1b]0;{t}\x07")
}

/// OSC 52 copy, wrapped for tmux and screen so it works over SSH too.
pub fn copy(text: &str, env: impl Fn(&str) -> Option<String>) -> String {
    let b = base64::engine::general_purpose::STANDARD.encode(text.as_bytes());
    let osc = format!("\x1b]52;c;{b}\x07");
    if env("TMUX").is_some() {
        format!("\x1bPtmux;{}\x1b\\", osc.replace('\x1b', "\x1b\x1b"))
    } else if env("TERM").is_some_and(|t| t.starts_with("screen")) {
        format!("\x1bP{osc}\x1b\\")
    } else {
        osc
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &'static [(&'static str, &'static str)]) -> impl Fn(&str) -> Option<String> {
        move |k| pairs.iter().find(|(a, _)| *a == k).map(|(_, v)| v.to_string())
    }

    #[test]
    fn notifications_follow_focus_and_the_switch() {
        let n = Notifier::from_env(env(&[]));
        assert_eq!(n.sequence("done", Some(true)), None);
        assert_eq!(n.sequence("done", None).as_deref(), Some("\x07"));
        assert_eq!(n.sequence("a\x1b;b", Some(false)).as_deref(), Some("\x1b]9;a b\x07"));
        assert_eq!(Notifier::from_env(env(&[("VTE_VERSION", "7000")])).sequence("x", Some(false)).as_deref(), Some("\x1b]777;notify;opc;x\x07"));
        assert_eq!(Notifier::from_env(env(&[("OPC_NOTIFY", "0")])).sequence("x", Some(false)), None);
    }

    #[test]
    fn copy_wraps_for_tmux() {
        assert_eq!(copy("hi", env(&[])), "\x1b]52;c;aGk=\x07");
        assert!(copy("hi", env(&[("TMUX", "1")])).starts_with("\x1bPtmux;\x1b\x1b]52"));
    }
}
