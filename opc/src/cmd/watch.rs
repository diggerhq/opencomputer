//! `opc watch`: print sessions' activity, read-only, until each is idle or
//! waiting (or, with `--follow`, until interrupted).

use super::follow::{Follower, Goal, Step, Tracker, detached_error};
use serde_json::json;
use super::run::{finish, race, stopped};
use super::{Ctx, print_line, println_out};
use crate::api::types::Event;
use crate::cli::{Format, OnAsk, WatchArgs};
use crate::error::{Error, Result, exit};
use crate::render::{self, Detail, Style};
use crate::wire::Attach;
use std::collections::HashMap;

pub async fn run(ctx: &mut Ctx, args: WatchArgs) -> Result<i32> {
    let format = if args.json { Format::Json } else { args.output_format.unwrap_or(Format::Text) };
    if args.include_partial_messages && format != Format::StreamJson {
        return Err(Error::usage("--include-partial-messages needs --output-format stream-json"));
    }
    let mut ops = args.ids.clone();
    if let Some(s) = &args.session.session {
        ops.insert(0, s.clone());
    }
    if ops.is_empty() {
        return Err(Error::usage("which session? opc watch <id>…"));
    }
    ctx.require_key()?;
    let mut sessions = Vec::new();
    for op in &ops {
        let id = super::resolve::resolve(ctx, op).await?.id;
        if !sessions.contains(&id) {
            sessions.push(id);
        }
    }
    let after = if args.from_start { Some(0) } else { args.after };
    let attaches = sessions.iter().map(|s| Attach { session_id: s.clone(), after, ..Default::default() }).collect();
    let deltas = format == Format::StreamJson && args.include_partial_messages;
    let (wire, rx) = ctx.open_wire(attaches, deltas).await?;
    let pairs: Vec<(String, bool)> = sessions.iter().map(|s| (s.clone(), after == Some(0))).collect();
    let mut f = Follower::new(wire, rx, &pairs);
    let mut trackers: Vec<Tracker> = sessions.iter().map(|s| Tracker::new(s, Goal::Settled, if args.follow { OnAsk::Wait } else { OnAsk::Fail }, false)).collect();
    let style = Style { color: ctx.color };
    let several = sessions.len() > 1;
    // With `--after`, recorded events are replayed after the attach: a session
    // that is already idle is reported only once the replay has printed.
    let mut printed: HashMap<String, u64> = HashMap::new();
    let mut last_done: Vec<Option<(String, super::follow::Done)>> = vec![None; trackers.len()];
    let mut failed: Vec<Option<Error>> = vec![None; trackers.len()];

    let outcome = race(args.timeout, async {
        loop {
            let step = f.next().await?;
            let lost = match &step {
                Step::AttachFailed(sid, e) => Some((sid.clone(), e.clone())),
                Step::Detached(sid, reason) => Some((sid.clone(), detached_error(sid, reason))),
                _ => None,
            };
            if let Some((sid, e)) = lost {
                // One session lost ends the watch only when it is the only
                // one: the others are still reported.
                if !several {
                    return Err(e);
                }
                if let Some(i) = sessions.iter().position(|s| *s == sid)
                    && failed[i].is_none()
                {
                    if format == Format::Text {
                        eprintln!("opc: {sid}: {}", e.message);
                    } else {
                        let mut line = e.to_json();
                        line["type"] = json!("error");
                        line["sessionId"] = json!(sid);
                        print_line(&line);
                    }
                    failed[i] = Some(e);
                    trackers[i].done = Some(Default::default());
                }
                if failed.iter().all(Option::is_some) {
                    return Ok(());
                }
                continue;
            }
            match &step {
                Step::Event(e) => {
                    printed.insert(e.session_id().to_string(), e.seq());
                    print_event(e, format, several, &style);
                }
                Step::Delta(d) if deltas && d.partial() => print_line(&d.0),
                Step::Reconnecting { attempt, retry_in, .. } if super::follow::worth_saying(*attempt, *retry_in) => ctx.progress(&format!("connection lost, reconnecting in {}", render::duration(retry_in.as_millis() as u64))),
                _ => {}
            }
            for (i, t) in trackers.iter_mut().enumerate() {
                if failed[i].is_some() {
                    continue;
                }
                t.update(&mut f, &step).await?;
                if let Some(done) = t.done.take() {
                    // A finished turn, for --json; with --follow, keep going.
                    if done.turn_id.is_some() || done.ask.is_some() {
                        last_done[i] = Some((t.session_id.clone(), done.clone()));
                    }
                    if args.follow {
                        *t = Tracker::new(&t.session_id, Goal::Settled, OnAsk::Wait, false);
                    } else {
                        t.done = Some(done);
                    }
                }
            }
            if args.follow {
                continue;
            }
            let caught_up = |sid: &str| {
                let Some(target) = after else { return true };
                let snap = f.state(sid).and_then(|s| s.info.as_ref()).map(|i| i.session.last_seq).unwrap_or(0);
                printed.get(sid).copied().unwrap_or(target) >= snap
            };
            if trackers.iter().enumerate().all(|(i, t)| failed[i].is_some() || (t.done.is_some() && caught_up(&t.session_id))) {
                return Ok(());
            }
        }
    })
    .await?;

    match outcome {
        Ok(()) => {
            let mut codes = Vec::new();
            for (i, t) in trackers.iter().enumerate() {
                if let Some(e) = &failed[i] {
                    codes.push(e.exit_code());
                    continue;
                }
                let done = t.done.clone().unwrap_or_default();
                let url = ctx.config.dashboard_url(&t.session_id);
                let code = match (format, &last_done[i]) {
                    (Format::Json, _) => {
                        let r = f.result(&t.session_id, &done, &url).await?;
                        finish(ctx, r.as_ref(), Format::Json)
                    }
                    _ if done.waiting() => exit::WAITING,
                    _ => match &done.turn_id {
                        Some(turn) => match f.state(&t.session_id).and_then(|s| s.ended.get(turn)) {
                            Some((status, _)) if status != "completed" => exit::TURN_FAILED,
                            _ => exit::OK,
                        },
                        None => exit::OK,
                    },
                };
                codes.push(code);
            }
            Ok(crate::api::result::combine_all(&codes))
        }
        Err(stop) => {
            let sid = sessions.first().cloned().unwrap_or_default();
            if args.follow && stop == super::run::Stop::Interrupted {
                return Ok(exit::INTERRUPTED);
            }
            Err(stopped(&f, &sid, None, stop, false).await)
        }
    }
}

fn print_event(e: &Event, format: Format, several: bool, style: &Style) {
    match format {
        Format::StreamJson => print_line(&e.0),
        Format::Text => {
            if let Some(text) = render::event_lines(e, Detail::Brief, style) {
                if several {
                    let tag = style.dim(&format!("[{}]", crate::ids::short(e.session_id())));
                    for l in text.lines() {
                        println_out(&format!("{tag} {l}"));
                    }
                } else {
                    println_out(&text);
                }
            }
        }
        Format::Json => {}
    }
}
