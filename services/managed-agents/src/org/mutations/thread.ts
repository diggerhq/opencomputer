// The thread mutations of spec 39: place, done, reopen, keep, ready, attention, writers, delete.
// (`thread.rename` is in index.ts.) Authorization is 19.2's table; a row the caller may not see or
// change is `not_found`.

import type { Principal } from "../../auth/principal.js";
import {
  agentArranges,
  isMember,
  isOwnSession,
  isPerson,
  ownsSession,
  ownsTrack,
  holdsTrack,
  readPlace,
  readSession,
  readTrack,
  seesSession,
  summaryOf,
  type PlaceRec,
  type SessionRec,
  type Tx,
} from "../tx.js";
import { byFor, Changes, isSid, isStr, isTid, markDone, optStr, ready, removeSession, unread } from "./common.js";
import { applied, refuse, type MutationFn, type MutationRefusal } from "./outcome.js";
import type { MutationName } from "./table.js";

type Thread = { s: SessionRec; place: PlaceRec };

/** The thread `sid` names, if `p` may see it; a track's agent session is not a thread. */
export function threadOf(tx: Tx, p: Principal, sid: unknown): Thread | MutationRefusal {
  if (!isSid(sid)) return refuse("invalid_request", "sid");
  const s = readSession(tx.sql, sid);
  if (!s || s.role === "track" || !seesSession(tx.sql, p, s)) return refuse("not_found");
  const place = readPlace(tx.sql, sid);
  if (!place) return refuse("not_found");
  return { s, place };
}

const isRefusal = (v: unknown): v is MutationRefusal => typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

/** 19.2: "They own the session" for a member; the platform (a rule) always; never an agent. */
const ownerOnly = (p: Principal, s: SessionRec): boolean => p.kind === "platform" || ownsSession(p, s);

/** 19.2: "It is the agent's own session" (the platform too); never a member. */
const ownAgent = (p: Principal, s: SessionRec): boolean => p.kind === "platform" || isOwnSession(p, s.id);

// ------------------------------------------------------------------ thread.place

const threadPlace: MutationFn = (tx, p, args) => {
  const { trackId } = args;
  if (trackId !== null && !isTid(trackId)) return refuse("invalid_request", "trackId");
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  const { s, place } = t;
  const target = trackId === null ? null : readTrack(tx.sql, trackId);
  if (trackId !== null && !target) return refuse("not_found");

  if (p.kind === "agent") {
    const startBox =
      s.role === "start" &&
      isOwnSession(p, s.id) &&
      place.track_id === null &&
      target !== null &&
      target.owner === s.owner &&
      target.done_at === null &&
      summaryOf(s).lastTurn === null &&
      tx.sql.exec("SELECT 1 FROM op WHERE name = 'thread.place' AND session_id = ?", s.id).length === 0;
    if (!startBox) {
      const reaches = agentArranges(tx.sql, p, place) || place.parent_session === p.session;
      const into = target === null ? place.track_id !== null && holdsTrack(p, readTrack(tx.sql, place.track_id)) : holdsTrack(p, target);
      if (!reaches || !into) return refuse("not_found");
      if (isPerson(place.placed_by)) return refuse("refused", "user_set");
      if (s.blocked === 1 || ready(tx, s, place) || unread(tx, s)) return refuse("refused", "marked");
    }
  } else if (p.kind !== "platform") {
    if (!ownsSession(p, s) || (target && !ownsTrack(p, target))) return refuse("not_found");
  }

  const by = byFor(p, args);
  const ch = new Changes(tx, by);
  ch.set("place", s.id, { track_id: target?.id ?? null, placed_by: by, position: tx.now });
  const op = ch.op({ name: "thread.place", args: { sid: s.id, trackId: target?.id ?? null }, sessionId: s.id, trackId: target?.id ?? place.track_id, audience: s.audience });
  tx.occurFor("thread.placed", s, by, target?.id ?? null);
  return applied({ op });
};

// ------------------------------------------------------------------ done, reopen, keep

const threadDone: MutationFn = (tx, p, args) => {
  if (!optStr(args.outcome, 200)) return refuse("invalid_request", "outcome");
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t.s)) return refuse("not_found");
  if (t.place.done_at !== null) return applied();
  const by = byFor(p, args);
  const ch = new Changes(tx, by);
  markDone(ch, t.place, (args.outcome as string | undefined) ?? "done");
  const op = ch.op({ name: "thread.done", args: { sid: t.s.id, outcome: args.outcome ?? null }, sessionId: t.s.id, trackId: t.place.track_id, audience: t.s.audience });
  tx.occurFor("thread.done", t.s, by, t.place.track_id);
  return applied({ op });
};

const threadReopen: MutationFn = (tx, p, args) => {
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t.s)) return refuse("not_found");
  const ch = new Changes(tx, byFor(p, args));
  ch.set("place", t.s.id, { done_at: null, outcome: null, done_by: null, earlier_at: null, brought_back_at: tx.now });
  const op = ch.op({ name: "thread.reopen", args: { sid: t.s.id }, sessionId: t.s.id, trackId: t.place.track_id, audience: t.s.audience });
  return applied({ op });
};

const threadKeep: MutationFn = (tx, p, args) => {
  if (typeof args.keep !== "boolean") return refuse("invalid_request", "keep");
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t.s)) return refuse("not_found");
  const ch = new Changes(tx, byFor(p, args));
  ch.set("place", t.s.id, args.keep ? { keep: 1, earlier_at: null } : { keep: 0 });
  const op = ch.op({ name: "thread.keep", args: { sid: t.s.id, keep: args.keep }, sessionId: t.s.id, trackId: t.place.track_id, audience: t.s.audience });
  return applied({ op });
};

// ------------------------------------------------------------------ ready, attention (the agent's own)

const threadReady: MutationFn = (tx, p, args) => {
  if (!isStr(args.what, 500)) return refuse("invalid_request", "what");
  if (args.resultId !== undefined && args.resultId !== null && !isStr(args.resultId, 100)) return refuse("invalid_request", "resultId");
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!ownAgent(p, t.s)) return refuse("not_found");
  const resultId = (args.resultId as string | null | undefined) ?? null;
  if (resultId !== null && tx.sql.exec("SELECT 1 FROM result WHERE id = ? AND session_id = ?", resultId, t.s.id).length === 0) return refuse("not_found", "result");
  tx.sql.exec("UPDATE place SET ready_seq = ?, ready_what = ?, ready_result = ? WHERE session_id = ?", summaryOf(t.s).lastSeq, args.what, resultId, t.s.id);
  tx.stamp("place", t.s.id);
  tx.occurFor("thread.ready", t.s, byFor(p, args), t.place.track_id);
  return applied();
};

const threadAttention: MutationFn = (tx, p, args) => {
  const what = args.what;
  if (what !== null && !isStr(what, 500)) return refuse("invalid_request", "what");
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!ownAgent(p, t.s)) return refuse("not_found");
  tx.sql.exec("UPDATE place SET attention = ? WHERE session_id = ?", what, t.s.id);
  tx.stamp("place", t.s.id);
  tx.reblock(t.s.id);
  if (what !== null) tx.occurFor("thread.attention", t.s, byFor(p, args), t.place.track_id);
  return applied();
};

// ------------------------------------------------------------------ writers

const threadWriters: MutationFn = (tx, p, args) => {
  const w = args.writers;
  const valid = w === "members" || (Array.isArray(w) && w.length <= 100 && w.every((x) => typeof x === "string" && /^(user|agent):.+$/.test(x)));
  if (!valid) return refuse("invalid_request", "writers");
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!(p.kind === "platform" || ownsSession(p, t.s) || (isMember(p) && p.admin))) return refuse("not_found");
  const ch = new Changes(tx, byFor(p, args));
  ch.set("session", t.s.id, { writers: JSON.stringify(w === "members" ? "members" : [...new Set(w as string[])]) });
  const op = ch.op({ name: "thread.writers", args: { sid: t.s.id, writers: w }, sessionId: t.s.id, trackId: t.place.track_id, audience: t.s.audience });
  return applied({ op });
};

// ------------------------------------------------------------------ delete

/** Remove a thread (spec 39, `thread.delete`), and dissolve its track if it has no thread left. */
export function deleteThread(tx: Tx, by: string, s: SessionRec, place: PlaceRec | null): void {
  removeSession(tx, s);
  const left = place?.track_id ?? null;
  if (left === null) return;
  const track = readTrack(tx.sql, left);
  if (!track) return;
  if (tx.sql.exec("SELECT 1 FROM place WHERE track_id = ?", left).length === 0) new Changes(tx, by).dissolve(left, "keep");
  else tx.sendAccess(track.agent_session);
}

const threadDelete: MutationFn = (tx, p, args) => {
  const t = threadOf(tx, p, args.sid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t.s)) return refuse("not_found");
  deleteThread(tx, byFor(p, args), t.s, t.place);
  return applied();
};

export const THREAD_MUTATIONS = {
  "thread.place": threadPlace,
  "thread.done": threadDone,
  "thread.reopen": threadReopen,
  "thread.keep": threadKeep,
  "thread.ready": threadReady,
  "thread.attention": threadAttention,
  "thread.writers": threadWriters,
  "thread.delete": threadDelete,
} satisfies Partial<Record<MutationName, MutationFn>>;
