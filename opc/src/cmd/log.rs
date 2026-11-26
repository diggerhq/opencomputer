//! `opc log`: a session's recorded history, read over HTTP. Never resumes a
//! suspended session.

use super::{Ctx, print_json, print_line, println_out};
use crate::api::types::Event;
use crate::cli::{Format, LogArgs};
use crate::error::{Error, Result};
use crate::http::session_path;
use crate::render::{self, Detail, Style};
use serde_json::{Value, json};

const PAGE: &str = "500";

pub async fn run(ctx: &mut Ctx, args: LogArgs) -> Result<i32> {
    let target = super::resolve::operand(args.id.as_deref(), args.session.session.as_deref())?
        .ok_or_else(|| Error::usage("which session? opc log <id>"))?;
    ctx.require_key()?;
    let sid = super::resolve::resolve(ctx, &target).await?.id;
    let format = args.output.format();
    let detail = if args.details { Detail::Full } else { Detail::Brief };
    let style = Style { color: ctx.color };
    let types = args.types.join(",");
    let mut after = args.after.unwrap_or(0);
    let mut all: Vec<Value> = Vec::new();
    let mut last_seq = 0u64;
    loop {
        let mut q: Vec<(&str, String)> = vec![("after", after.to_string()), ("limit", PAGE.to_string())];
        if let Some(t) = &args.turn {
            q.push(("turnId", t.clone()));
        }
        if !types.is_empty() {
            q.push(("types", types.clone()));
        }
        let q: Vec<(String, String)> = q.into_iter().map(|(k, v)| (k.to_string(), v)).collect();
        let page = ctx.http.get(&session_path(&sid, "/events"), &q).await?;
        let events = page.get("events").and_then(Value::as_array).cloned().unwrap_or_default();
        last_seq = page.get("lastSeq").and_then(Value::as_u64).unwrap_or(last_seq);
        let more = page.get("hasMore").and_then(Value::as_bool).unwrap_or(false);
        for v in events {
            let e = Event(v);
            after = after.max(e.seq());
            match format {
                Format::StreamJson => print_line(&e.0),
                Format::Text => {
                    if let Some(text) = render::event_lines(&e, detail, &style) {
                        println_out(&text);
                    }
                }
                Format::Json => all.push(e.0),
            }
        }
        if !more {
            break;
        }
    }
    if format == Format::Json {
        print_json(ctx, &json!({"events": all, "lastSeq": last_seq, "hasMore": false}));
    }
    Ok(0)
}
