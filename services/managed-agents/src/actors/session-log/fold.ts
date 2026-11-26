// The session log's fold (work 084): recorded events → Turns, Asks and the LogSummary, with no I/O.
// The SessionLog DO runs it incrementally on every append against its SQL tables (a FoldStore);
// `foldEvents` (memory-fold.ts) runs it over an array against memory (tests, the Computer DO, a rebuild).
//
// Event shapes follow the public schema (opc docs/api/reference/events.mdx, the vendored
// computer-api.v1.json). Unknown types, and fields the fold does not use, are ignored.
//
// Turns:
// - `message.received` with delivery `started`/`queued` (or any other) creates its turn, `queued`
//   until `turn.started`; `steered` joins the running turn (`turnId`) as a `steering` entry (one that
//   declined open asks too: those close by their own `ask.closed` with status `declined`).
// - A steered message the turn ends without reading starts a new turn with a new id that has
//   no `message.received` of its own (`turn.queued`/`turn.started` under an unknown id): it takes the
//   oldest such message's input and author, and that message leaves the ended turn's `steering`.
// - `usage.recorded` sums into the turn; `Turn.usage` shows the sum once the turn has ended.
//
// Subagents (subagents.md): `subagent.started {subagent}` / `subagent.ended {subagent}` carry the whole
// object. The stored object's `result` is cut to 8 KiB (`resultTruncated`); the full text stays in the
// `subagent.ended` event (`resultSeq`), where `GET` one reads it. `subagent.progress` is never journaled
// (the SessionLog keeps it in memory) and is ignored here if it shows up.

import type { ApiEvent, Ask, SessionStatus, Steering, Subagent, SubagentStatus, Turn, TurnError, TurnStatus } from "../../api-objects/objects.js";
import { actorOf, bool, int, normalizeAsk, normalizeSubagent, obj, personOf, str } from "./event-data.js";
import type { FoldState, FoldStore, TurnRecord } from "./fold-state.js";
import { SYSTEM_ACTOR } from "./system-actor.js";
import { addUsage, newTurn, publicTurn, turnSummary } from "./turns.js";
import { truncateUtf8 } from "./utf8.js";

export const LAST_TEXT_CHARS = 200;
/** A Subagent's `result` is inline up to this many UTF-8 bytes. */
export const INLINE_RESULT_BYTES = 8 * 1024;
const ENDED_SUBAGENT_STATUSES = new Set<SubagentStatus>(["completed", "failed", "stopped"]);

/** The events in which the agent said something to the session's people (spec 35.2, `lastAgentSeq`). */
const AGENT_SPOKE = new Set(["message.completed", "ask.opened", "turn.completed", "turn.failed"]);

/** Fold one recorded event into `state` and `store`. */
export function applyEvent(state: FoldState, store: FoldStore, sessionId: string, event: ApiEvent): void {
  state.lastActiveAt = event.createdAt;
  const data = obj(event.data);
  const turnId = event.turnId;
  if (AGENT_SPOKE.has(event.type) && (event.type !== "message.completed" || data.parentCallId == null)) state.lastAgentSeq = event.seq;
  switch (event.type) {
    case "session.created": {
      state.title = str(data.title) ?? state.title;
      const s = obj(data.settings);
      if (data.settings) state.settings = { model: str(s.model), effort: str(s.effort), mode: str(s.mode) ?? "default", speed: str(s.speed) };
      return;
    }
    case "session.updated": {
      const changes = obj(data.changes);
      for (const [field, change] of Object.entries(changes)) {
        const to = obj(change).to;
        if (field === "title") state.title = str(to) ?? state.title;
        else if (field === "settings") {
          const s = obj(to);
          state.settings = { model: str(s.model), effort: str(s.effort), mode: str(s.mode) ?? state.settings?.mode ?? "default", speed: str(s.speed) };
        } else if (field === "model" || field === "effort" || field === "mode" || field === "speed") {
          const current = state.settings ?? { model: null, effort: null, mode: "default", speed: null };
          state.settings = { ...current, [field]: field === "mode" ? (str(to) ?? current.mode) : str(to) };
        }
      }
      return;
    }
    case "session.status_changed": {
      const to = str(data.to);
      if (to) state.status = to as SessionStatus;
      return;
    }
    case "session.compacted": {
      const after = int(data.afterTokens);
      if (after !== null) state.context = { ...state.context, usedTokens: after };
      return;
    }
    case "usage.recorded": {
      state.context = { usedTokens: int(data.usedTokens), windowTokens: int(data.windowTokens) };
      if (turnId) {
        const record = store.turn(turnId);
        if (record) store.putTurn({ ...record, usage: addUsage(record.usage, data) });
      }
      return;
    }
    case "message.received": {
      state.orphans = [];
      if (!turnId) return;
      const input = str(data.input) ?? "";
      const ifBusy = str(data.ifBusy) ?? "queue";
      const author = actorOf(event.actor) ?? SYSTEM_ACTOR;
      const delivery = str(data.delivery);
      const existing = store.turn(turnId);
      if (delivery === "steered" && existing) {
        const steering: Steering = { input, author, createdAt: event.createdAt };
        store.putTurn({ ...existing, turn: { ...existing.turn, steering: [...existing.turn.steering, steering] } });
        state.pending = [...state.pending, { turnId, input, ifBusy, author, createdAt: event.createdAt, seq: event.seq }];
        return;
      }
      if (existing) return;
      store.putTurn({ turn: newTurn(sessionId, turnId, event.createdAt, input, ifBusy, author), seq: event.seq, usage: null });
      return;
    }
    case "turn.steered": {
      // The agent read a steered message: it is the turn's for good. `messageSeq` names it; a writer that predates
      // the field means the oldest one of this turn (calvin takes steering in FIFO order).
      const messageSeq = typeof data.messageSeq === "number" ? data.messageSeq : null;
      const named = messageSeq === null ? -1 : state.pending.findIndex((p) => p.turnId === turnId && p.seq === messageSeq);
      const i = named >= 0 ? named : state.pending.findIndex((p) => p.turnId === turnId);
      if (i >= 0) state.pending = state.pending.filter((_, j) => j !== i);
      return;
    }
    case "turn.queued":
    case "turn.started": {
      if (!turnId) return;
      // `trigger`/`subagentId` from the Turn calvin may send, or top-level; `message`/null when absent.
      const sent = obj(data.turn);
      const trigger = str(sent.trigger) ?? str(data.trigger);
      const subagentId = str(sent.subagentId) ?? str(data.subagentId);
      let record = store.turn(turnId);
      if (!record && trigger !== null && trigger !== "message") {
        // A turn the harness started on its own (a background subagent ended): no message, no orphan.
        record = { turn: newTurn(sessionId, turnId, event.createdAt, null, "queue", null), seq: event.seq, usage: null };
      }
      record ??= adoptOrphan(state, store, sessionId, turnId, event);
      if (trigger !== null) {
        record = {
          ...record,
          turn: {
            ...record.turn,
            trigger,
            subagentId,
            input: trigger === "message" ? record.turn.input : null,
            author: trigger === "message" ? record.turn.author : null,
          },
        };
      }
      if (event.type === "turn.started") {
        record = { ...record, turn: { ...record.turn, status: "running", startedAt: event.createdAt } };
        state.activeTurnId = turnId;
      }
      store.putTurn(record);
      return;
    }
    case "turn.status_changed": {
      const record = turnId ? store.turn(turnId) : undefined;
      const to = str(data.to);
      if (!record || !to) return;
      store.putTurn({ ...record, turn: { ...record.turn, status: to as TurnStatus } });
      return;
    }
    case "turn.completed":
    case "turn.failed":
    case "turn.cancelled": {
      if (!turnId) return;
      const record = store.turn(turnId);
      if (!record) return;
      const turn: Turn = { ...record.turn, endedAt: event.createdAt };
      if (event.type === "turn.completed") {
        turn.status = "completed";
        turn.text = str(data.text);
        if (turn.text !== null) state.lastText = turn.text.slice(0, LAST_TEXT_CHARS);
      } else if (event.type === "turn.failed") {
        turn.status = "failed";
        const e = obj(data.error);
        turn.error = { ...e, code: str(e.code) ?? "agent_failed", message: str(e.message) ?? "" } as TurnError;
      } else {
        turn.status = "cancelled";
        turn.reason = str(data.reason);
        turn.forced = bool(data.forced);
      }
      const ended: TurnRecord = { ...record, turn };
      store.putTurn(ended);
      if (state.activeTurnId === turnId) state.activeTurnId = null;
      state.lastTurn = turnSummary(publicTurn(ended));
      state.orphans = state.pending.filter((p) => p.turnId === turnId);
      state.pending = state.pending.filter((p) => p.turnId !== turnId);
      return;
    }
    case "message.completed": {
      if (data.parentCallId == null) {
        const text = str(data.text);
        if (text !== null) state.lastText = text.slice(0, LAST_TEXT_CHARS);
      }
      return;
    }
    case "tool.started": {
      const callId = str(data.callId);
      if (!callId) return;
      store.openTool({
        callId,
        turnId,
        toolName: str(data.toolName) ?? "",
        title: str(data.title) ?? "",
        parentCallId: str(data.parentCallId),
        seq: event.seq,
      });
      return;
    }
    case "tool.completed":
    case "tool.failed": {
      const callId = str(data.callId);
      if (callId) store.closeTool(callId);
      return;
    }
    case "ask.opened": {
      const ask = normalizeAsk(data.ask, sessionId, turnId, event.createdAt);
      if (!ask.id) return;
      const existing = store.ask(ask.id);
      store.putAsk({ ask, seq: existing?.seq ?? event.seq });
      return;
    }
    case "ask.closed": {
      const closed = normalizeAsk(data.ask, sessionId, turnId, event.createdAt);
      if (!closed.id) return;
      const existing = store.ask(closed.id);
      const base = existing?.ask ?? closed;
      const ask: Ask = {
        ...base,
        status: closed.status === "open" ? "dismissed" : closed.status,
        closedAt: closed.closedAt ?? event.createdAt,
        closedBy: closed.closedBy ?? (closed.status === "interrupted" ? null : actorOf(event.actor)),
        answer: closed.answer,
      };
      store.putAsk({ ask, seq: existing?.seq ?? event.seq });
      return;
    }
    case "subagent.started": {
      const started = normalizeSubagent(data.subagent, sessionId, turnId, event.createdAt);
      if (!started.id) return;
      const existing = store.subagent(started.id);
      if (existing && existing.subagent.status !== "running") return; // a late or resent start never reopens it
      store.putSubagent({ subagent: { ...started, status: "running", endedAt: null, durationMs: null, result: null, resultTruncated: false, error: null, stoppedBy: null }, seq: existing?.seq ?? event.seq, endSeq: null, resultSeq: null });
      return;
    }
    case "subagent.ended": {
      const raw = obj(data.subagent);
      const id = str(raw.id);
      if (!id) return;
      const existing = store.subagent(id);
      // Fields the ended object leaves out keep their started values.
      const ended = normalizeSubagent({ ...existing?.subagent, ...raw }, sessionId, turnId, event.createdAt);
      const base = existing?.subagent ?? ended;
      const status = ENDED_SUBAGENT_STATUSES.has(ended.status) ? ended.status : "failed";
      const endedAt = ended.endedAt ?? event.createdAt;
      const started = Date.parse(base.createdAt);
      const cut = ended.result === null ? { text: null, truncated: false } : truncateUtf8(ended.result, INLINE_RESULT_BYTES);
      const subagent: Subagent = {
        ...base,
        ...ended,
        id: base.id,
        createdAt: base.createdAt,
        turnId: base.turnId || ended.turnId,
        status,
        endedAt,
        durationMs: ended.durationMs ?? (Number.isFinite(started) ? Math.max(0, Date.parse(endedAt) - started) : null),
        result: cut.text,
        resultTruncated: cut.truncated,
        stoppedBy: ended.stoppedBy ?? (status === "stopped" ? personOf(event.actor) : null),
      };
      store.putSubagent({ subagent, seq: existing?.seq ?? event.seq, endSeq: event.seq, resultSeq: cut.truncated ? event.seq : null });
      return;
    }
    default:
      // Includes `subagent.progress`: never journaled; ignored if it is.
      return;
  }
}

function adoptOrphan(state: FoldState, store: FoldStore, sessionId: string, turnId: string, event: ApiEvent): TurnRecord {
  const orphan = state.orphans[0];
  if (!orphan) {
    // No message to adopt: no input and no author (docs: the input or null).
    return { turn: newTurn(sessionId, turnId, event.createdAt, null, "queue", null), seq: event.seq, usage: null };
  }
  state.orphans = state.orphans.slice(1);
  const from = store.turn(orphan.turnId);
  if (from) {
    const i = from.turn.steering.findIndex((s) => s.createdAt === orphan.createdAt && s.input === orphan.input);
    if (i >= 0) store.putTurn({ ...from, turn: { ...from.turn, steering: from.turn.steering.filter((_, j) => j !== i) } });
  }
  return {
    turn: newTurn(sessionId, turnId, orphan.createdAt, orphan.input, orphan.ifBusy, orphan.author),
    seq: event.seq,
    usage: null,
  };
}
