//! `opc wait`: block until a session settles, or a turn ends or waits for a
//! person; with several, the first (`--any`) or every one (`--all`).

use super::follow::{self, Follower, Goal, Tracker};
use super::run::{Stop, finish, race, stopped};
use super::{Ctx, print_line, println_out};
use serde_json::json;
use crate::api::result;
use crate::cache;
use crate::cli::{Format, OnAsk, WaitArgs};
use crate::error::{Error, Result};
use crate::ids;
use crate::wire::Attach;
use std::time::Instant;

/// What one operand waits for.
#[derive(Debug, Clone)]
struct Target {
    session_id: String,
    goal: Goal,
}

async fn targets(ctx: &Ctx, args: &WaitArgs) -> Result<Vec<Target>> {
    let mut out = Vec::new();
    let mut ops = args.ids.clone();
    if let Some(s) = &args.session.session {
        ops.insert(0, s.clone());
    }
    if ops.is_empty() {
        return Err(Error::usage("which session? opc wait <id> [--turn <tn_…>]"));
    }
    if let Some(turn) = &args.turn {
        if ops.len() != 1 || ids::looks_like_turn(&ops[0]) {
            return Err(Error::usage("--turn goes with exactly one session: opc wait <id> --turn <tn_…>"));
        }
        let r = super::resolve::resolve(ctx, &ops[0]).await?;
        return Ok(vec![Target { session_id: r.id, goal: Goal::Turn(turn.clone()) }]);
    }
    for op in ops {
        if ids::looks_like_turn(&op) {
            let sid = cache::session_for_turn(&op).ok_or_else(|| {
                Error::usage(format!("{op} was not sent from this machine: name its session too, opc wait <id> --turn {op}"))
                    .hint("the handle line (opc: session cs_… turn tn_…) gives both ids; this machine remembers its last 500 turns")
            })?;
            out.push(Target { session_id: sid, goal: Goal::Turn(op) });
        } else {
            let r = super::resolve::resolve(ctx, &op).await?;
            out.push(Target { session_id: r.id, goal: Goal::Settled });
        }
    }
    Ok(out)
}

pub async fn run(ctx: &mut Ctx, args: WaitArgs) -> Result<i32> {
    ctx.require_key()?;
    ctx.http.set_deadline(args.timeout.map(|t| Instant::now() + t));
    let targets = targets(ctx, &args).await?;
    let format = if args.json { Format::Json } else { Format::Text };
    let several = targets.len() > 1;

    let mut sessions: Vec<String> = Vec::new();
    for t in &targets {
        if !sessions.contains(&t.session_id) {
            sessions.push(t.session_id.clone());
        }
    }
    let attaches = sessions.iter().map(|s| Attach { session_id: s.clone(), ..Default::default() }).collect();
    let (wire, rx) = ctx.open_wire(attaches, false).await?;
    let pairs: Vec<(String, bool)> = sessions.iter().map(|s| (s.clone(), false)).collect();
    let mut f = Follower::new(wire, rx, &pairs);
    let mut trackers: Vec<Tracker> = targets.iter().map(|t| Tracker::new(&t.session_id, t.goal.clone(), args.on_ask.unwrap_or(OnAsk::Fail), args.wait_subagents)).collect();

    let mut codes: Vec<Option<i32>> = vec![None; trackers.len()];
    let any = args.any;
    let outcome = race(args.timeout, async {
        let mut sink = |_: &Follower, _: &follow::Step| {};
        loop {
            let i = follow::run_until_next(&mut f, &mut trackers, &mut sink).await?;
            let t = &trackers[i];
            if let Some(e) = &t.failed {
                // This session could not be followed; the others go on.
                if format == Format::Json {
                    let mut line = e.stream_result_line();
                    line["sessionId"] = json!(t.session_id);
                    print_line(&line);
                } else {
                    eprintln!("opc: {}: {}", t.session_id, e.message);
                }
                codes[i] = Some(e.exit_code());
                // With --any, a lost session is not the answer: wait on.
                if codes.iter().all(Option::is_some) {
                    return Ok(e.exit_code());
                }
                continue;
            }
            let done = t.done.clone().unwrap_or_default();
            let url = ctx.config.dashboard_url(&t.session_id);
            let r = f.result(&t.session_id, &done, &url).await?;
            let code = if several {
                match &r {
                    Some(r) if format == Format::Json => {
                        print_line(r);
                        result::exit_code(r)
                    }
                    other => {
                        // Say which session each answer is from.
                        if codes.iter().any(Option::is_some) {
                            println_out("");
                        }
                        println_out(&format!("── {}", t.session_id));
                        finish(ctx, other.as_ref(), format)
                    }
                }
            } else {
                finish(ctx, r.as_ref(), format)
            };
            codes[i] = Some(code);
            if any || codes.iter().all(Option::is_some) {
                return Ok(code);
            }
        }
    })
    .await?;
    match outcome {
        Ok(code) if any || !several => Ok(code),
        Ok(_) => Ok(result::combine_all(&codes.iter().flatten().copied().collect::<Vec<_>>())),
        Err(stop) => {
            let pending: Vec<&Tracker> = trackers.iter().filter(|t| t.done.is_none()).collect();
            let first = pending.first().map(|t| t.session_id.clone()).unwrap_or_default();
            let e = stopped(&f, &first, None, stop, false).await;
            Err(if stop == Stop::Timeout { e.with("pending", pending.iter().map(|t| t.session_id.clone()).collect::<Vec<_>>()) } else { e })
        }
    }
}
