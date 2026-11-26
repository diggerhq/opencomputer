//! `opc send`: send a message and return when it is accepted, or with
//! `--wait`, follow the turn it ended up in to its Result.

use super::follow::{Follower, Goal, Tracker};
use super::run::{Printer, follow_turn, remember, send};
use super::{Ctx, print_json, println_out};
use crate::cli::{Format, OnAsk, SendArgs};
use crate::error::{Error, Result};
use crate::wire::Attach;
use std::time::Instant;

pub async fn run(ctx: &mut Ctx, args: SendArgs) -> Result<i32> {
    let (target, words): (String, Vec<String>) = match &args.session.session {
        Some(s) => (s.clone(), args.args.clone()),
        None => {
            let mut it = args.args.clone().into_iter();
            let first = it.next().ok_or_else(|| Error::usage("opc send <id> <message>"))?;
            (first, it.collect())
        }
    };
    if words.is_empty() && ctx.tty.stdin {
        return Err(Error::usage("no message: opc send <id> <message | ->"));
    }
    let message = super::message_from(&words, true, ctx.tty)?.ok_or_else(|| Error::usage("no message: opc send <id> <message | ->"))?;
    super::check_message(&message)?;
    ctx.require_key()?;
    ctx.http.set_deadline(args.timeout.map(|t| Instant::now() + t));
    let resolved = super::resolve::resolve(ctx, &target).await?;
    let sid = resolved.id;
    let if_busy = args.delivery.if_busy().as_str();
    let key = args.idempotency_key.clone().unwrap_or_else(crate::ids::idempotency_key);

    if !args.wait {
        let sent = send(ctx, &sid, &message, if_busy, Some(&key)).await?;
        remember(&sid, Some(&sent.turn.id));
        if args.json {
            print_json(ctx, &serde_json::to_value(&sent)?);
        } else {
            println_out(&sent.turn.id);
            if ctx.tty.stderr && !ctx.global.quiet {
                eprintln!("opc wait {}", sent.turn.id);
            }
        }
        return Ok(0);
    }

    // Attach while the message is sent, so following costs no extra round trip.
    let wire = ctx.open_wire(vec![Attach { session_id: sid.clone(), ..Default::default() }], false);
    let (wire, sent) = tokio::join!(wire, send(ctx, &sid, &message, if_busy, Some(&key)));
    let (wire, rx) = wire?;
    let sent = sent?;
    remember(&sid, Some(&sent.turn.id));
    let steered = (sent.delivery == "steered" || sent.delivery == "held").then(|| message.clone());
    let mut f = Follower::new(wire, rx, &[(sid.clone(), false)]);
    let tracker = Tracker::new(&sid, Goal::Turn(sent.turn.id.clone()), args.on_ask.unwrap_or(OnAsk::Fail), args.wait_subagents).steered(steered).sent_seq(sent.seq);
    let format = if args.json { Format::Json } else { Format::Text };
    let printer = Printer { format, partial: false, progress: false, sessions: vec![sid.clone()] };
    let url = ctx.url_for(resolved.session.as_ref(), &sid);
    follow_turn(ctx, &mut f, tracker, &printer, &url, args.timeout, false, false).await
}
