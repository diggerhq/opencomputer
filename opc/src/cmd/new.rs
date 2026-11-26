//! `opc new`: create a session, send the message if given, return at once.

use super::run::{create, remember};
use super::{Ctx, print_json, println_out};
use crate::cli::NewArgs;
use crate::error::Result;
use serde_json::json;

pub async fn run(ctx: &mut Ctx, args: NewArgs) -> Result<i32> {
    let message = super::message_from(&args.message, true, ctx.tty)?;
    if let Some(m) = &message {
        super::check_message(m)?;
    }
    ctx.require_key()?;
    let id = super::run::new_session_id(ctx, &args.new)?;
    let (created, sent) = create(ctx, &id, &args.new, message.as_deref()).await?;
    let sid = created.session.id.clone();
    let (turn, delivery, seq) = match &sent {
        Some(s) => (Some(s.turn.clone()), Some(s.delivery.clone()), s.seq),
        None => (created.turn.clone(), created.delivery.clone(), created.seq),
    };
    remember(&sid, turn.as_ref().map(|t| t.id.as_str()));
    crate::cache::upsert_session(ctx.http.api_url(), &created.session);
    if args.json {
        print_json(
            ctx,
            &json!({"session": created.session, "turn": turn, "delivery": delivery, "duplicate": created.duplicate, "seq": seq}),
        );
    } else {
        println_out(&sid);
        if let Some(t) = &turn {
            ctx.progress(&format!("turn {} · opc wait {} · opc a {}", t.id, t.id, sid));
        }
    }
    Ok(0)
}
