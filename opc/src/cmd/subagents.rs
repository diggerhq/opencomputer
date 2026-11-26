//! `opc subagents [ls|stop|result]`.

use super::{Ctx, print_json, println_out};
use crate::api::types::Subagent;
use crate::cli::{SubagentArgs, SubagentsArgs, SubagentsCommand, SubagentsLsArgs};
use crate::error::{Error, Result};
use crate::http::{q, session_path};
use crate::render;
use serde_json::{Value, json};
use std::time::Duration;

pub async fn run(ctx: &Ctx, a: SubagentsArgs) -> Result<i32> {
    ctx.require_key()?;
    match a.command {
        None => ls(ctx, a.ls).await,
        Some(SubagentsCommand::Ls(l)) => ls(ctx, l).await,
        Some(SubagentsCommand::Stop(s)) => stop(ctx, s).await,
        Some(SubagentsCommand::Result(s)) => result(ctx, s).await,
    }
}

async fn session(ctx: &Ctx, positional: Option<&str>, flag: Option<&str>) -> Result<String> {
    let t = super::resolve::operand(positional, flag)?;
    Ok(super::resolve::session_or_last(ctx, t.as_deref(), true).await?.id)
}

fn parse(v: &Value) -> Result<Subagent> {
    serde_json::from_value(v.clone()).map_err(|e| Error::new("internal", format!("the API returned a subagent opc cannot read: {e}")))
}

async fn ls(ctx: &Ctx, a: SubagentsLsArgs) -> Result<i32> {
    let sid = session(ctx, a.id.as_deref(), a.session.session.as_deref()).await?;
    let status = if a.all_statuses { "all" } else { "running" };
    let mut all: Vec<Value> = Vec::new();
    let mut cursor: Option<String> = None;
    loop {
        let mut query = q(&[("status", status), ("limit", "100")]);
        if let Some(c) = &cursor {
            query.push(("cursor".into(), c.clone()));
        }
        let got = ctx.http.get(&session_path(&sid, "/subagents"), &query).await?;
        all.extend(got.get("subagents").and_then(Value::as_array).cloned().unwrap_or_default());
        match got.get("nextCursor").and_then(Value::as_str) {
            Some(n) if all.len() < 500 => cursor = Some(n.to_string()),
            _ => break,
        }
    }
    if a.json {
        print_json(ctx, &json!({"subagents": all}));
        return Ok(0);
    }
    if all.is_empty() {
        ctx.progress(if a.all_statuses { "no subagents" } else { "no subagents running (--all-statuses for ended ones)" });
    }
    let now = time::OffsetDateTime::now_utc();
    for v in &all {
        let sa = parse(v)?;
        let mut line = format!("{}  {:<9}  {}", sa.id, sa.status, render::subagent_line(&sa));
        if sa.is_running()
            && let Some(t) = sa.created_at.as_deref().and_then(crate::api::result::parse_time)
        {
            line.push_str(&format!(" · {}", render::duration(((now - t).whole_milliseconds().max(0)) as u64)));
        }
        println_out(&line);
    }
    Ok(0)
}

async fn stop(ctx: &Ctx, a: SubagentArgs) -> Result<i32> {
    check_id(&a.subagent)?;
    let sid = session(ctx, None, a.session.session.as_deref()).await?;
    let path = session_path(&sid, &format!("/subagents/{}", a.subagent));
    let mut sa = match ctx.http.post(&format!("{path}/stop"), &json!({}), None).await {
        Ok(v) => parse(v.get("subagent").unwrap_or(&Value::Null))?,
        // Already ended: that is what was asked for.
        Err(e) if e.code == "subagent_ended" => parse(e.extra.get("subagent").unwrap_or(&Value::Null))?,
        Err(e) => return Err(e),
    };
    if a.json {
        // Print it once it has ended.
        let deadline = std::time::Instant::now() + Duration::from_secs(30);
        while sa.is_running() && std::time::Instant::now() < deadline {
            tokio::time::sleep(Duration::from_millis(250)).await;
            let got = ctx.http.get(&path, &[]).await?;
            sa = parse(got.get("subagent").unwrap_or(&Value::Null))?;
        }
        print_json(ctx, &serde_json::to_value(&sa)?);
    } else {
        ctx.progress(&format!("{} {}", sa.id, if sa.is_running() { "stopping" } else { sa.status.as_str() }));
    }
    Ok(0)
}

async fn result(ctx: &Ctx, a: SubagentArgs) -> Result<i32> {
    check_id(&a.subagent)?;
    let sid = session(ctx, None, a.session.session.as_deref()).await?;
    let got = ctx.http.get(&session_path(&sid, &format!("/subagents/{}", a.subagent)), &[]).await?;
    let v = got.get("subagent").cloned().unwrap_or(Value::Null);
    let sa = parse(&v)?;
    if a.json {
        print_json(ctx, &v);
        return Ok(0);
    }
    if sa.is_running() {
        return Err(Error::new("subagent_running", format!("{} is still running: {}", sa.id, sa.activity.as_deref().unwrap_or("working")))
            .hint(format!("wait for it with opc wait {sid} --wait-subagents, or stop it with opc subagents stop {}", sa.id)));
    }
    match &sa.result {
        Some(r) => println_out(r),
        None => ctx.progress(&format!("{} {} without a result", sa.id, sa.status)),
    }
    Ok(if sa.status == "completed" { 0 } else { crate::error::exit::TURN_FAILED })
}

fn check_id(id: &str) -> Result<()> {
    if crate::ids::looks_like_subagent(id) { Ok(()) } else { Err(Error::usage(format!("{id} is not a subagent id (sa_…)"))) }
}
