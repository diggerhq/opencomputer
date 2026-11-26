//! `opc a` and the interactive `opc`: the session screen, the picker, and
//! the plain transcript when stdout is no terminal.

use std::time::Instant;

use serde_json::{Map, Value, json};

use super::{Ctx, resolve};
use crate::cli::{AttachArgs, RunArgs};
use crate::error::{Error, Result, exit};
use crate::ui::app::{self, Create, Exit, Start};
use crate::wire::Attach;

/// `opc a [target]`.
pub async fn run(ctx: &mut Ctx, a: AttachArgs) -> Result<i32> {
    let words = (!a.target.is_empty()).then(|| a.target.join(" "));
    let target = resolve::operand(words.as_deref(), a.session.session.as_deref())?;
    let interactive = ctx.tty.interactive();
    let id = match target {
        Some(t) => match resolve::resolve(ctx, &t).await {
            Ok(r) => r.id,
            Err(e) if e.code == "session_ambiguous" && interactive => {
                let only: Vec<String> = e.extra.get("matches").and_then(Value::as_array).map(|v| v.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                if only.is_empty() {
                    return Err(e);
                }
                match app::pick(ctx, Some(only)).await? {
                    Some(id) => id,
                    None => return Ok(exit::OK),
                }
            }
            Err(e) => return Err(e),
        },
        None if !interactive => return Err(Error::usage("which session? pass an id, a prefix, - or words (the picker needs a terminal)")),
        None => match app::pick(ctx, None).await? {
            Some(id) => id,
            None => return Ok(exit::OK),
        },
    };
    if !interactive {
        let tail = if a.no_history { Some(0) } else { Some(a.history.unwrap_or(1)) };
        return crate::ui::plain::follow(ctx, &id, tail).await;
    }
    attach_loop(ctx, id, a.read_only, a.history, a.no_history).await
}

/// Runs screens until the person detaches: `/sessions` and `/new` move to
/// another session without leaving.
async fn attach_loop(ctx: &mut Ctx, mut id: String, read_only: bool, history: Option<u32>, no_history: bool) -> Result<i32> {
    loop {
        let start = attach_start(&id, read_only, history, no_history);
        match app::session(ctx, start).await? {
            Exit::Detach => return Ok(exit::OK),
            Exit::Attach(next) => id = next,
            Exit::New => return Box::pin(run_new(ctx, RunArgs::default(), None)).await,
        }
    }
}

/// Where an attach starts: from the cache when there is one, so the
/// screen draws before the network answers.
fn attach_start(id: &str, read_only: bool, history: Option<u32>, no_history: bool) -> Start {
    let launched = Instant::now();
    let cached = crate::cache::load_events(id);
    let base = Start {
        session_id: id.to_string(),
        read_only,
        attach: Attach { session_id: id.to_string(), after: None, tail_turns: None, log_epoch: None },
        cached: Vec::new(),
        cached_shown_from: 0,
        cache_writes: false,
        create: None,
        message: None,
        earlier: true,
        launched,
    };
    match (history, no_history, cached.last_seq(), cached.log_epoch) {
        (None, false, Some(last), Some(epoch)) => {
            // The last turn in full, the earlier ones counted.
            let from = cached.events.iter().rposition(|e| e.kind() == "turn.started").unwrap_or(0);
            Start {
                attach: Attach { session_id: id.to_string(), after: Some(last), tail_turns: None, log_epoch: Some(epoch) },
                cached: cached.events,
                cached_shown_from: from,
                cache_writes: true,
                earlier: false,
                ..base
            }
        }
        (None, true, Some(last), Some(epoch)) => {
            let n = cached.events.len();
            Start {
                attach: Attach { session_id: id.to_string(), after: Some(last), tail_turns: None, log_epoch: Some(epoch) },
                cached: cached.events,
                cached_shown_from: n,
                cache_writes: true,
                earlier: false,
                ..base
            }
        }
        _ => {
            let tail = if no_history { 0 } else { history.unwrap_or(1) };
            Start {
                attach: Attach { tail_turns: Some(tail), ..base.attach.clone() },
                // A tail is a sparse log: the cache takes it only when empty.
                cache_writes: cached.events.is_empty(),
                earlier: !no_history,
                ..base
            }
        }
    }
}

/// The body of `POST /sessions`, without the message.
fn create_body(id: &str, run: &RunArgs) -> Value {
    let n = &run.new;
    let mut b = Map::new();
    b.insert("id".into(), json!(id));
    for (k, v) in [("model", &n.model), ("effort", &n.effort), ("speed", &n.speed), ("mode", &n.mode), ("title", &n.title)] {
        if let Some(v) = v {
            b.insert(k.into(), json!(v));
        }
    }
    if !n.metadata.is_empty() {
        let m: Map<String, Value> = n.metadata.iter().map(|(k, v)| (k.clone(), json!(v))).collect();
        b.insert("metadata".into(), Value::Object(m));
    }
    Value::Object(b)
}

/// Interactive `opc [message]`: a new session. The screen draws before
/// any network; the session is created with the first message.
pub async fn run_new(ctx: &mut Ctx, run: RunArgs, message: Option<String>) -> Result<i32> {
    let launched = Instant::now();
    if !ctx.tty.interactive() {
        return Err(Error::usage("the interactive session needs a terminal: use opc -p"));
    }
    let id = super::run::new_session_id(ctx, &run.new)?;
    let key = run.new.idempotency_key.clone().unwrap_or_else(crate::ids::idempotency_key);
    let create = Create { body: create_body(&id, &run), key, push: run.new.push.clone() };
    let start = Start {
        session_id: id.clone(),
        read_only: false,
        attach: Attach { session_id: id, after: Some(0), tail_turns: None, log_epoch: None },
        cached: Vec::new(),
        cached_shown_from: 0,
        cache_writes: true,
        create: Some(create),
        message: message.filter(|m| !m.trim().is_empty()),
        earlier: false,
        launched,
    };
    match app::session(ctx, start).await? {
        Exit::Detach => Ok(exit::OK),
        Exit::Attach(next) => attach_loop(ctx, next, false, None, false).await,
        Exit::New => Box::pin(run_new(ctx, RunArgs::default(), None)).await,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn create_bodies_omit_what_was_not_given() {
        let mut r = RunArgs::default();
        assert_eq!(create_body("cs_x", &r), json!({"id": "cs_x"}));
        r.new.model = Some("opus".into());
        r.new.metadata = vec![("ticket".into(), "ENG-1".into())];
        assert_eq!(create_body("cs_x", &r), json!({"id": "cs_x", "model": "opus", "metadata": {"ticket": "ENG-1"}}));
        r.new.speed = Some("standard".into());
        assert_eq!(create_body("cs_x", &r)["speed"], "standard");
    }

    #[test]
    fn attaches_without_a_cache_ask_for_a_tail() {
        let s = attach_start("cs_aaaaaaaaaaaaaaaaaaaaaaaaaa", false, Some(3), false);
        assert_eq!(s.attach.tail_turns, Some(3));
        assert!(s.earlier);
        let s = attach_start("cs_aaaaaaaaaaaaaaaaaaaaaaaaaa", true, None, true);
        assert_eq!(s.attach.tail_turns, Some(0));
        assert!(!s.earlier && s.read_only);
    }
}
