//! `opc interrupt`, `rename`, `archive`, `unarchive`, `open` and `diff`.

use super::resolve::{operand, resolve};
use super::{Ctx, print_json, println_out};
use crate::api::types::{Session, Turn};
use crate::cli::{DiffArgs, InterruptArgs, OpenArgs, RenameArgs, SessionOnly, ShellArgs};
use crate::error::{Error, Result};
use crate::http::{q, session_path};
use serde_json::{Value, json};

fn need(positional: Option<&str>, flag: Option<&str>, usage: &str) -> Result<String> {
    operand(positional, flag)?.ok_or_else(|| Error::usage(format!("which session? {usage}")))
}

pub async fn interrupt(ctx: &Ctx, a: InterruptArgs) -> Result<i32> {
    let target = need(a.id.as_deref(), a.session.session.as_deref(), "opc interrupt <id>")?;
    ctx.require_key()?;
    let sid = resolve(ctx, &target).await?.id;
    let got = ctx.http.post(&session_path(&sid, "/interrupt"), &json!({}), None).await?;
    let session: Session = serde_json::from_value(got.get("session").cloned().unwrap_or(Value::Null))
        .map_err(|e| Error::new("internal", format!("the API returned a session opc cannot read: {e}")))?;
    let mut cancelled: Vec<Value> = Vec::new();
    // Queued turns are already cancelled in the response.
    for t in &session.queued {
        cancelled.push(serde_json::to_value(t)?);
    }
    if let Some(active) = &session.active_turn_id {
        let path = session_path(&sid, &format!("/turns/{active}"));
        let turn = if a.no_wait {
            ctx.http.get(&path, &[]).await?
        } else {
            ctx.http.get(&path, &q(&[("status", "cancelling"), ("waitMs", "60000")])).await?
        };
        cancelled.insert(0, turn.get("turn").cloned().unwrap_or(turn));
    }
    if a.json {
        print_json(ctx, &json!({"cancelled": cancelled}));
        return Ok(0);
    }
    if cancelled.is_empty() {
        ctx.note("nothing was running");
        return Ok(0);
    }
    for t in &cancelled {
        let t: Turn = serde_json::from_value(t.clone()).unwrap_or_default();
        let state = if t.status == "cancelling" { "stopping" } else { t.status.as_str() };
        println_out(&format!("{} {state}", t.id));
    }
    // Under Claude Code an interrupt also stops the turn's subagents,
    // background ones included: say so rather than promise they carry on.
    if session.active_turn_id.is_some() && !session.subagents.is_empty() {
        ctx.progress("the turn's subagents were stopped with it");
    }
    Ok(0)
}

pub async fn rename(ctx: &Ctx, a: RenameArgs) -> Result<i32> {
    let (target, words) = match &a.session.session {
        Some(s) => (s.clone(), a.args.clone()),
        None => {
            let mut it = a.args.clone().into_iter();
            (it.next().unwrap_or_default(), it.collect::<Vec<_>>())
        }
    };
    let title = words.join(" ");
    if title.trim().is_empty() {
        return Err(Error::usage("no title: opc rename <id> <title>"));
    }
    if title.chars().count() > 200 {
        return Err(Error::usage("the title is longer than 200 characters"));
    }
    ctx.require_key()?;
    let sid = resolve(ctx, &target).await?.id;
    let got = ctx.http.patch(&session_path(&sid, ""), &json!({"title": title.trim()})).await?;
    if let Ok(s) = serde_json::from_value::<Session>(got.get("session").cloned().unwrap_or(got.clone())) {
        crate::cache::upsert_session(ctx.http.api_url(), &s);
    }
    Ok(0)
}

pub async fn archive(ctx: &Ctx, a: SessionOnly, archived: bool) -> Result<i32> {
    let verb = if archived { "archive" } else { "unarchive" };
    let target = need(a.id.as_deref(), a.session.session.as_deref(), &format!("opc {verb} <id>"))?;
    ctx.require_key()?;
    let sid = resolve(ctx, &target).await?.id;
    ctx.http.patch(&session_path(&sid, ""), &json!({"archived": archived})).await?;
    ctx.progress(&format!("{sid} {verb}d"));
    Ok(0)
}

pub async fn open(ctx: &Ctx, a: OpenArgs) -> Result<i32> {
    let target = operand(a.id.as_deref(), a.session.session.as_deref())?;
    let r = super::resolve::session_or_last(ctx, target.as_deref(), true).await?;
    let url = ctx.url_for(r.session.as_ref(), &r.id);
    if !(ctx.tty.stdout && open_browser(&url)) {
        println_out(&url);
    }
    Ok(0)
}

/// Opens a link in the browser; false when there is none to open.
pub fn open_browser(url: &str) -> bool {
    // `BROWSER`: a command, or several separated by ':', tried in order;
    // `%s` stands for the link, else it goes last.
    if let Some(list) = std::env::var("BROWSER").ok().filter(|b| !b.trim().is_empty()) {
        for entry in list.split(':').map(str::trim).filter(|e| !e.is_empty()) {
            let mut words: Vec<String> = entry.split_whitespace().map(|w| w.replace("%s", url)).collect();
            if !entry.contains("%s") {
                words.push(url.to_string());
            }
            let Some((cmd, args)) = words.split_first() else { continue };
            let ok = std::process::Command::new(cmd)
                .args(args)
                .stdin(std::process::Stdio::null())
                .stdout(std::process::Stdio::null())
                .stderr(std::process::Stdio::null())
                .spawn()
                .is_ok();
            if ok {
                return true;
            }
        }
        return false;
    }
    if std::env::var_os("SSH_CONNECTION").is_some() && std::env::var_os("DISPLAY").is_none() {
        return false;
    }
    let cmd = if cfg!(target_os = "macos") {
        "open"
    } else if cfg!(windows) {
        "explorer"
    } else {
        if std::env::var_os("DISPLAY").is_none() && std::env::var_os("WAYLAND_DISPLAY").is_none() {
            return false;
        }
        "xdg-open"
    };
    std::process::Command::new(cmd)
        .arg(url)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .spawn()
        .is_ok()
}

/// The script `opc diff` runs in the workspace: `git diff` of every
/// repository, each under its path, then its untracked files by name.
/// Read-only: it never touches the repositories' index.
pub fn diff_script(stat: bool, color: bool) -> String {
    let stat = if stat { " --stat" } else { "" };
    let color = if color { "always" } else { "never" };
    format!(
        "for g in $(find . -maxdepth 4 -name .git -prune 2>/dev/null | sort); do d=${{g%/.git}}; \
         out=$(git -C \"$d\" diff HEAD{stat} --color={color} 2>/dev/null; \
         git -C \"$d\" ls-files --others --exclude-standard 2>/dev/null | sed 's/^/new file (untracked): /'); \
         [ -n \"$out\" ] && printf '%s\\n%s\\n\\n' \"── ${{d#./}}\" \"$out\"; done; true"
    )
}

pub async fn diff(ctx: &Ctx, a: DiffArgs) -> Result<i32> {
    let target = need(a.id.as_deref(), a.session.session.as_deref(), "opc diff <id>")?;
    ctx.require_key()?;
    let sid = resolve(ctx, &target).await?.id;
    let script = diff_script(a.stat, ctx.color);
    if ctx.tty.stdout {
        // Through $PAGER: run ourselves for the shell, piped into it.
        let pager = std::env::var("PAGER").ok().filter(|p| !p.trim().is_empty()).unwrap_or_else(|| "less -FRX".into());
        let exe = std::env::current_exe().map_err(|e| Error::new("internal", format!("cannot find opc itself: {e}")))?;
        let mut child = std::process::Command::new(exe)
            .args(["shell", "-s", &sid, "--no-tty", "-c", &script])
            .stdout(std::process::Stdio::piped())
            .spawn()
            .map_err(|e| Error::new("internal", format!("cannot run the shell: {e}")))?;
        let out = child.stdout.take().ok_or_else(|| Error::new("internal", "no shell output"))?;
        let mut parts = pager.split_whitespace();
        let prog = parts.next().unwrap_or("less");
        let paged = std::process::Command::new(prog).args(parts).stdin(out).status();
        let code = child.wait().map(|s| s.code().unwrap_or(1)).unwrap_or(1);
        if paged.is_err() {
            return Err(Error::new("internal", format!("cannot run the pager {pager:?}")));
        }
        return Ok(code);
    }
    super::shell::run(ctx, ShellArgs { id: None, session: crate::cli::SessionOpt { session: Some(sid) }, command: Some(script), no_tty: true }).await
}
