//! `opc ask`: list and answer asks without attaching.

use super::{Ctx, print_json, println_out};
use crate::api::types::{Ask, Session};
use crate::cli::{AskAnswerArgs, AskCommand, AskDecideArgs, AskLsArgs};
use crate::error::{Error, Result};
use crate::http::session_path;
use serde_json::{Map, Value, json};

pub async fn run(ctx: &Ctx, a: AskCommand) -> Result<i32> {
    ctx.require_key()?;
    match a {
        AskCommand::Ls(a) => ls(ctx, a).await,
        AskCommand::Allow(a) => decide(ctx, a, "allow").await,
        AskCommand::Deny(a) => decide(ctx, a, "deny").await,
        AskCommand::Always(a) => decide(ctx, a, "always").await,
        AskCommand::Dismiss(a) => dismiss(ctx, a).await,
        AskCommand::Answer(a) => answer(ctx, a).await,
    }
}

/// Sessions with open asks: waiting ones, paged.
async fn waiting_sessions(ctx: &Ctx, owner: &str) -> Result<Vec<Session>> {
    let mut out = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let (page, next) =
            super::resolve::list(ctx, &[("owner", owner), ("status", "waiting"), ("archived", "all"), ("limit", "100")], cursor.as_deref()).await?;
        out.extend(page);
        match next {
            Some(n) if out.len() < 500 => cursor = Some(n),
            _ => return Ok(out),
        }
    }
}

async fn session_asks(ctx: &Ctx, sid: &str) -> Result<Vec<Value>> {
    let got = ctx.http.get(&session_path(sid, "/asks"), &crate::http::q(&[("status", "open"), ("limit", "100")])).await?;
    Ok(got.get("asks").and_then(Value::as_array).cloned().unwrap_or_default())
}

async fn ls(ctx: &Ctx, a: AskLsArgs) -> Result<i32> {
    let target = super::resolve::operand(a.id.as_deref(), a.session.session.as_deref())?;
    let asks: Vec<Value> = match target {
        Some(t) => {
            let sid = super::resolve::resolve(ctx, &t).await?.id;
            session_asks(ctx, &sid).await?
        }
        None => waiting_sessions(ctx, "me")
            .await?
            .iter()
            .flat_map(|s| s.asks.iter().filter(|a| a.is_open()).filter_map(|a| serde_json::to_value(a).ok()))
            .collect(),
    };
    if a.json {
        print_json(ctx, &json!({"asks": asks}));
        return Ok(0);
    }
    if asks.is_empty() {
        ctx.progress("no open asks");
    }
    for v in &asks {
        if let Ok(ask) = serde_json::from_value::<Ask>(v.clone()) {
            println_out(&format!("{}  {}  {}", ask.id, crate::ids::short(&ask.session_id), ask.describe()));
        }
    }
    Ok(0)
}

/// The session an ask is in: `-s`, else found among the open asks of the
/// sessions you can see.
async fn find(ctx: &Ctx, ask_id: &str, session: Option<&str>) -> Result<(String, Option<Ask>)> {
    if !crate::ids::is_ask_id(ask_id) {
        return Err(Error::usage(format!("{ask_id} is not an ask id (ak_…)")));
    }
    if let Some(s) = session {
        return Ok((super::resolve::resolve(ctx, s).await?.id, None));
    }
    for s in waiting_sessions(ctx, "anyone").await? {
        if let Some(a) = s.asks.iter().find(|a| a.id == ask_id) {
            return Ok((s.id.clone(), Some(a.clone())));
        }
    }
    Err(Error::new("ask_not_found", format!("no open ask {ask_id} in the sessions you can see")).hint("if it is closed or in a session you cannot list, pass -s <id>"))
}

async fn post_answer(ctx: &Ctx, sid: &str, ask_id: &str, route: &str, body: Value, json_out: bool) -> Result<i32> {
    let got = match ctx.http.post(&session_path(sid, &format!("/asks/{ask_id}/{route}")), &body, None).await {
        Ok(v) => v,
        Err(e) if e.code == "ask_closed" => {
            let by = e.extra.get("ask").and_then(|a| a.pointer("/closedBy/name")).and_then(Value::as_str);
            let status = e.extra.get("ask").and_then(|a| a.get("status")).and_then(Value::as_str).unwrap_or("closed");
            let msg = match by {
                Some(n) => format!("{ask_id} was already {status} by {n}"),
                None => format!("{ask_id} was already {status}"),
            };
            return Err(Error { message: msg, ..e });
        }
        Err(e) => return Err(e),
    };
    let ask = got.get("ask").cloned().unwrap_or(Value::Null);
    if json_out {
        print_json(ctx, &ask);
    } else {
        let status = ask.get("status").and_then(Value::as_str).unwrap_or("answered");
        ctx.progress(&format!("{ask_id} {status}"));
    }
    Ok(0)
}

async fn decide(ctx: &Ctx, a: AskDecideArgs, decision: &str) -> Result<i32> {
    if a.mode.is_some() && decision == "deny" {
        return Err(Error::usage("--mode goes with allow or always: it is the mode a plan switches to"));
    }
    let (sid, ask) = find(ctx, &a.ask, a.session.session.as_deref()).await?;
    if let Some(ask) = &ask {
        if ask.kind != "approval" {
            return Err(Error::usage(format!("{} is a {} ask: {}", a.ask, ask.kind, hint_for(&ask.kind, &a.ask))));
        }
        if decision == "always" && ask.approval.as_ref().is_some_and(|p| p.always_allows.is_none()) {
            return Err(Error::usage(format!("{} has no rule to always allow: use opc ask allow", a.ask)));
        }
    }
    let mut body = Map::new();
    body.insert("decision".into(), json!(decision));
    if let Some(m) = &a.message {
        body.insert("message".into(), json!(m));
    }
    if let Some(m) = &a.mode {
        body.insert("mode".into(), json!(m));
    }
    post_answer(ctx, &sid, &a.ask, "answer", Value::Object(body), a.json).await
}

async fn dismiss(ctx: &Ctx, a: AskDecideArgs) -> Result<i32> {
    if a.mode.is_some() {
        return Err(Error::usage("--mode goes with allow or always"));
    }
    let (sid, _) = find(ctx, &a.ask, a.session.session.as_deref()).await?;
    let body = match &a.message {
        Some(m) => json!({"message": m}),
        None => json!({}),
    };
    post_answer(ctx, &sid, &a.ask, "dismiss", body, a.json).await
}

fn hint_for(kind: &str, ask: &str) -> String {
    match kind {
        "question" => format!("answer it with opc ask answer {ask} --choice <label>"),
        "secret" => format!("it is answered in Slack; skip it with opc ask dismiss {ask}"),
        _ => format!("answer it with opc ask allow|deny {ask}"),
    }
}

async fn answer(ctx: &Ctx, a: AskAnswerArgs) -> Result<i32> {
    let from_stdin = match a.stdin.as_deref() {
        Some("-") => true,
        Some(other) => return Err(Error::usage(format!("unexpected {other:?}: pass - to read the answer body from standard input"))),
        None => false,
    };
    if from_stdin && (!a.choice.is_empty() || a.text.is_some()) {
        return Err(Error::usage("give the answer once: --choice/--text, or a body on standard input with -"));
    }
    if !from_stdin && a.choice.is_empty() && a.text.is_none() {
        return Err(Error::usage("no answer: pass --choice <label> or --text <text>"));
    }
    let (sid, ask) = find(ctx, &a.ask, a.session.session.as_deref()).await?;
    let ask = match ask {
        Some(x) => x,
        None => {
            let got = ctx.http.get(&session_path(&sid, &format!("/asks/{}", a.ask)), &[]).await?;
            serde_json::from_value(got.get("ask").cloned().unwrap_or(Value::Null))?
        }
    };
    if ask.kind == "secret" {
        return Err(Error::new("answer_with_secret", format!("{} asks for a secret: {}", a.ask, hint_for("secret", &a.ask))));
    }
    if ask.kind != "question" {
        return Err(Error::usage(format!("{} is an approval: {}", a.ask, hint_for(&ask.kind, &a.ask))));
    }
    let body: Value = if from_stdin {
        serde_json::from_str(&super::read_stdin()?).map_err(|e| Error::usage(format!("the answer body is not JSON: {e}")))?
    } else {
        let qs = ask.question.as_ref().map(|q| q.questions.clone()).unwrap_or_default();
        if qs.len() != 1 {
            return Err(Error::usage(format!("{} has {} questions: pass the answer body on standard input with -", a.ask, qs.len())));
        }
        let q = &qs[0];
        for c in &a.choice {
            if !q.options.iter().any(|o| &o.label == c) {
                let labels: Vec<&str> = q.options.iter().map(|o| o.label.as_str()).collect();
                return Err(Error::new("invalid_answer", format!("{c:?} is not one of the options")).hint(format!("options: {}", labels.join(" · "))));
            }
        }
        if a.choice.len() > 1 && !q.multi_select {
            return Err(Error::new("invalid_answer", "this question takes one choice"));
        }
        json!({"answers": [{"questionId": q.id, "choices": a.choice, "text": a.text}]})
    };
    post_answer(ctx, &sid, &a.ask, "answer", body, a.json).await
}
