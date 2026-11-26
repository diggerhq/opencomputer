//! `opc a` when stdout is no terminal: the same short transcript as plain
//! text, followed until the session settles. Nothing is drawn, nothing is
//! read from the keyboard.

use std::time::Duration;

use super::model::{Model, RIGHT};
use super::{TLine, now_ms};
use crate::cmd::Ctx;
use crate::error::{Error, Result, exit};
use crate::wire::{Attach, WireEvent};

/// How long a settled session may stay quiet, with catch-up events still
/// missing, before we take it as caught up.
const QUIET_MS: i64 = 2_000;

/// A line as plain text, without the right-hand facts of live rows.
pub fn plain_line(l: &TLine) -> String {
    let mut s = " ".repeat(l.lead);
    for g in l.segs.iter().filter(|g| g.link.as_deref() != Some(RIGHT)) {
        s.push_str(&super::clean(&g.text));
    }
    s.trim_end().to_string()
}

fn flush(m: &mut Model) {
    for l in m.take_out() {
        crate::cmd::println_out(&plain_line(&l));
    }
    let _ = m.take_effects();
}

/// What the session is doing, for the exit decision.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Settle {
    Busy,
    Done,
    Waiting,
}

/// Whether a followed session has settled: caught up (or quiet), no turn,
/// nothing queued; an open ask ends the follow too.
pub fn settle(m: &Model, attached: bool, quiet_ms: i64) -> Settle {
    if !attached {
        return Settle::Busy;
    }
    let caught_up = m.last_seq >= m.catchup_seq || quiet_ms >= QUIET_MS;
    if !caught_up {
        return Settle::Busy;
    }
    if m.open_asks().next().is_some() {
        return Settle::Waiting;
    }
    let busy = m.turn_running() || !m.queued.is_empty() || matches!(m.status.as_str(), "running" | "starting");
    if busy { Settle::Busy } else { Settle::Done }
}

/// Follows a session and prints it; returns the exit code.
pub async fn follow(ctx: &Ctx, session_id: &str, tail_turns: Option<u32>) -> Result<i32> {
    let attach = Attach { session_id: session_id.to_string(), after: None, tail_turns, log_epoch: None };
    let (wire, mut rx) = ctx.open_wire(vec![attach], false).await?;
    let mut m = Model::new(session_id, true);
    let mut attached = false;
    let mut last_event = now_ms();
    let mut tick = tokio::time::interval(Duration::from_millis(250));
    let code = loop {
        tokio::select! {
            ev = rx.recv() => {
                let now = now_ms();
                let Some(ev) = ev else { break Err(Error::unreachable("the connection closed")) };
                match ev {
                    WireEvent::Attached { session_id: sid, result } if sid == session_id => match result {
                        Ok(info) => {
                            m.attached(&info, now);
                            if let Some(t) = &info.earlier_turns {
                                m.earlier(t);
                            }
                            attached = true;
                        }
                        Err(e) => break Err(e),
                    },
                    WireEvent::Event(e) => {
                        m.event(&e, now);
                        last_event = now;
                    }
                    WireEvent::EpochReset { epoch_start_seq, .. } => m.epoch_reset(epoch_start_seq),
                    WireEvent::Detached { reason, .. } => break Err(Error::new("detached", format!("the server stopped sending this session: {reason}"))),
                    WireEvent::Fatal(e) => break Err(e),
                    _ => {}
                }
            }
            _ = tick.tick() => {
                m.tick(now_ms());
            }
        }
        flush(&mut m);
        match settle(&m, attached, now_ms() - last_event) {
            Settle::Busy => {}
            Settle::Done => break Ok(exit::OK),
            Settle::Waiting => {
                for a in m.open_asks() {
                    crate::cmd::println_out(&format!("  ? {} · waiting for an answer ({})", a.describe(), a.id));
                }
                break Ok(exit::WAITING);
            }
        }
    };
    flush(&mut m);
    wire.close();
    code
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::api::types::Event;
    use crate::ui::{Seg, Sty};
    use serde_json::json;

    #[test]
    fn plain_lines_drop_right_facts_and_controls() {
        let mut l = TLine::row(2).s("✓ Bash\x1b[2J  done", Sty::Ok);
        l.segs.push(Seg { text: "12 s".into(), sty: Sty::Dim, link: Some(RIGHT.into()) });
        assert_eq!(plain_line(&l), "  ✓ Bash[2J  done");
    }

    #[test]
    fn settles_only_when_caught_up_and_idle() {
        let mut m = Model::new("cs_x", true);
        assert_eq!(settle(&m, false, 0), Settle::Busy);
        m.catchup_seq = 3;
        assert_eq!(settle(&m, true, 0), Settle::Busy);
        assert_eq!(settle(&m, true, QUIET_MS), Settle::Done);
        let ev = |seq: u64, kind: &str, data: serde_json::Value| Event(json!({"seq": seq, "type": kind, "sessionId": "cs_x", "turnId": "tn_1", "data": data}));
        m.event(&ev(1, "turn.started", json!({})), 0);
        m.event(&ev(3, "ask.opened", json!({"ask": {"id": "ak_1", "kind": "question", "status": "open"}})), 0);
        assert_eq!(settle(&m, true, 0), Settle::Waiting);
    }
}
