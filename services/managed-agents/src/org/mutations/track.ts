// The track mutations of spec 39 and 40.7: create, rename, set_stand, done, reopen, keep, dissolve,
// delete. Authorization is 19.2's table; a track the caller may not see or change is `not_found`.

import type { Principal } from "../../actor/principal.js";
import type { Origin } from "../../computer/api-types.js";
import { isPerson, ownsSession, ownsTrack, holdsTrack, isOwnSession, parse, readSession, readTrack, seesTrack, summaryOf, type TrackRec, type Tx } from "../tx.js";
import { acceptOpenProposals, addTrackAgent, byFor, Changes, firstMachine, isSid, isStr, isTid, markDone, optStr, placesOf, removeSession } from "./common.js";
import { applied, refuse, type MutationFn, type MutationRefusal } from "./outcome.js";
import type { MutationName } from "./table.js";
import { deleteThread, threadOf } from "./thread.js";

const isRefusal = (v: unknown): v is MutationRefusal => typeof v === "object" && v !== null && (v as { ok?: unknown }).ok === false;

/** The track `tid` names, if `p` may see it. */
function trackOf(tx: Tx, p: Principal, tid: unknown): TrackRec | MutationRefusal {
  if (!isTid(tid)) return refuse("invalid_request", "tid");
  const t = readTrack(tx.sql, tid);
  if (!t || !seesTrack(tx.sql, p, t)) return refuse("not_found");
  return t;
}

/** 19.2: "They own the track" for a member; the platform always; never an agent. */
const ownerOnly = (p: Principal, t: TrackRec): boolean => p.kind === "platform" || ownsTrack(p, t);
/** 19.2: the owner, or the agent that holds the track role for it. */
const ownerOrRole = (p: Principal, t: TrackRec): boolean => ownerOnly(p, t) || holdsTrack(p, t);

// ------------------------------------------------------------------ track.create (40.7)

const trackCreate: MutationFn = (tx, p, args) => {
  const { tid, agentSessionId, sid, name, firstInput, person } = args as typeof args & { person?: { name: string | null; email: string | null } };
  if (!isTid(tid)) return refuse("invalid_request", "tid");
  if (!isSid(agentSessionId)) return refuse("invalid_request", "agentSessionId");
  if (!optStr(name, 200)) return refuse("invalid_request", "name");
  if (!optStr(firstInput, 20_000)) return refuse("invalid_request", "firstInput");
  if (sid !== undefined && sid !== null && !isSid(sid)) return refuse("invalid_request", "sid");

  // Who the track is for, and which thread it wraps or (start box) removes.
  let wrapped = null as ReturnType<typeof threadOf> | null;
  if (typeof sid === "string") {
    wrapped = threadOf(tx, p, sid);
    if (isRefusal(wrapped)) return wrapped;
  }
  const w = wrapped as Exclude<ReturnType<typeof threadOf>, MutationRefusal> | null;
  let owner: string;
  let startBox = null as Exclude<ReturnType<typeof threadOf>, MutationRefusal> | null;
  if (p.kind === "agent") {
    if (w) {
      // G3: wrapping its own session, which is on its own.
      if (!isOwnSession(p, w.s.id)) return refuse("not_found");
      // R30: an Undo of a wrap by a person is not overridden by the agent.
      if (tx.sql.exec<{ undone_by: string }>("SELECT undone_by FROM op WHERE name = 'track.create' AND session_id = ? AND undone_by IS NOT NULL", w.s.id).some((r) => isPerson(r.undone_by)))
        return refuse("refused", "user_set");
    } else {
      // J5: from the start box, in its first turn; the calling thread is removed.
      const own = p.session ? threadOf(tx, p, p.session) : refuse("not_found");
      if (isRefusal(own)) return own;
      if (own.s.role !== "start" || own.place.track_id !== null || summaryOf(own.s).lastTurn !== null) return refuse("not_found");
      startBox = own;
    }
    owner = (w ?? startBox)!.s.owner;
  } else if (p.kind === "platform") {
    if (w) owner = w.s.owner;
    else if (isStr(args.owner, 100)) owner = args.owner;
    else return refuse("invalid_request", "owner");
  } else {
    if (w && !ownsSession(p, w.s)) return refuse("not_found");
    owner = p.subject;
  }
  if (w && w.place.track_id !== null) return refuse("refused", "in_track");
  if (readTrack(tx.sql, tid) || readSession(tx.sql, agentSessionId)) return refuse("taken");

  const by = byFor(p, args);
  const source = (w ?? startBox)?.s ?? null;
  const origin = source ? parse<Origin>(source.origin, { type: "api", client: null, slack: null }) : { type: "api", client: null, slack: null };
  const audience = `member:${owner}`;
  const title = typeof name === "string" && name.trim() !== "" ? name.trim() : null;
  tx.sql.exec(
    "INSERT INTO track (id, owner, name, name_by, agent_session, position, created_by, version, audience) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)",
    tid,
    owner,
    title,
    title === null ? null : by,
    agentSessionId,
    tx.now,
    by,
    tx.version(),
    audience,
  );
  tx.sql.exec("INSERT INTO doc (track_id, rev, text, spans, version, audience) VALUES (?, 0, '', '[]', ?, ?)", tid, tx.version(), audience);

  const lines = [
    p.kind === "agent" ? `This track was made by the agent of thread ${p.session} (${by}), for ${owner}.` : `This track was made by ${by}.`,
    w ? `It wraps the thread ${w.s.id} ("${w.s.title ?? summaryOf(w.s).agentTitle ?? "untitled"}"). Read it before you act.` : "It has no thread yet.",
    ...(typeof firstInput === "string" && firstInput !== "" ? ["The person's words:", firstInput] : []),
    p.kind === "agent" ? "You may start threads for the work it asks for." : "Do not start threads until the person asks you to.",
  ];
  addTrackAgent(tx, {
    id: agentSessionId,
    trackId: tid,
    owner,
    // A thread it comes from names its owner; from a person with none, the edge's name for them.
    ownerName: source?.owner_name ?? (p.kind !== "agent" ? (person?.name ?? null) : null),
    ownerEmail: source?.owner_email ?? (p.kind !== "agent" ? (person?.email ?? null) : null),
    origin,
    machine: source?.machine ?? firstMachine(tx),
    by,
    name: title,
    firstInput: lines.join("\n\n"),
  });

  const ch = new Changes(tx, by);
  ch.created(tid);
  if (w) ch.set("place", w.s.id, { track_id: tid, placed_by: by, position: tx.now });
  const op = ch.op({ name: "track.create", args: { tid, agentSessionId, name: title, sid: w?.s.id ?? null }, sessionId: w?.s.id ?? null, trackId: tid, audience });
  if (startBox) deleteThread(tx, by, startBox.s, startBox.place);
  return applied({ op, trackId: tid });
};

// ------------------------------------------------------------------ rename, stand

const trackRename: MutationFn = (tx, p, args) => {
  if (!isStr(args.name, 200) || args.name.trim() === "") return refuse("invalid_request", "name");
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOrRole(p, t)) return refuse("not_found");
  if (p.kind === "agent" && isPerson(t.name_by)) return refuse("refused", "user_set");
  const by = byFor(p, args);
  const former = parse<string[]>(t.former_names, []);
  if (t.name !== null) former.push(t.name);
  const ch = new Changes(tx, by);
  ch.set("track", t.id, { name: args.name.trim(), name_by: by, former_names: JSON.stringify(former.slice(-20)) });
  tx.sql.exec("UPDATE session SET title = ?, title_by = ? WHERE id = ?", args.name.trim(), by, t.agent_session);
  tx.stamp("session", t.agent_session);
  const op = ch.op({ name: "track.rename", args: { tid: t.id, name: args.name.trim() }, trackId: t.id, audience: t.audience });
  return applied({ op });
};

const trackSetStand: MutationFn = (tx, p, args) => {
  if (args.stand !== null && !isStr(args.stand, 2000)) return refuse("invalid_request", "stand");
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOrRole(p, t)) return refuse("not_found");
  tx.sql.exec("UPDATE track SET stand = ?, stand_at = ? WHERE id = ?", args.stand, tx.now, t.id);
  tx.stamp("track", t.id);
  return applied();
};

// ------------------------------------------------------------------ done, reopen, keep

const trackDone: MutationFn = (tx, p, args) => {
  if (!optStr(args.outcome, 200)) return refuse("invalid_request", "outcome");
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t)) return refuse("not_found");
  if (t.done_at !== null) return applied();
  const by = byFor(p, args);
  const outcome = (args.outcome as string | null | undefined) ?? "done";
  const ch = new Changes(tx, by);
  for (const place of placesOf(tx, t.id)) {
    if (place.done_at !== null) continue;
    markDone(ch, place, outcome);
    const s = readSession(tx.sql, place.session_id);
    if (s) tx.occurFor("thread.done", s, by, t.id);
  }
  ch.set("track", t.id, { done_at: tx.now, outcome });
  acceptOpenProposals(tx, t.id, "done");
  const op = ch.op({ name: "track.done", args: { tid: t.id, outcome }, trackId: t.id, audience: t.audience });
  return applied({ op });
};

const trackReopen: MutationFn = (tx, p, args) => {
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t)) return refuse("not_found");
  const ch = new Changes(tx, byFor(p, args));
  ch.set("track", t.id, { done_at: null, outcome: null });
  const op = ch.op({ name: "track.reopen", args: { tid: t.id }, trackId: t.id, audience: t.audience });
  return applied({ op });
};

const trackKeep: MutationFn = (tx, p, args) => {
  if (typeof args.keep !== "boolean") return refuse("invalid_request", "keep");
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t)) return refuse("not_found");
  const ch = new Changes(tx, byFor(p, args));
  ch.set("track", t.id, { keep: args.keep ? 1 : 0 });
  const op = ch.op({ name: "track.keep", args: { tid: t.id, keep: args.keep }, trackId: t.id, audience: t.audience });
  return applied({ op });
};

// ------------------------------------------------------------------ dissolve, delete

const trackDissolve: MutationFn = (tx, p, args) => {
  const threads = args.threads ?? "keep";
  if (threads !== "keep" && threads !== "stop") return refuse("invalid_request", "threads");
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t)) return refuse("not_found");
  const ch = new Changes(tx, byFor(p, args));
  ch.dissolve(t.id, threads);
  const op = ch.op({ name: "track.dissolve", args: { tid: t.id, threads }, trackId: t.id, audience: t.audience });
  return applied({ op });
};

const trackDelete: MutationFn = (tx, p, args) => {
  const t = trackOf(tx, p, args.tid);
  if (isRefusal(t)) return t;
  if (!ownerOnly(p, t)) return refuse("not_found");
  for (const place of placesOf(tx, t.id)) {
    const s = readSession(tx.sql, place.session_id);
    if (s) removeSession(tx, s);
  }
  new Changes(tx, byFor(p, args)).dissolve(t.id, "keep");
  tx.sql.exec("DELETE FROM doc_rev WHERE track_id = ?", t.id);
  for (const r of tx.sql.exec<{ id: string }>("SELECT id FROM op WHERE track_id = ?", t.id)) tx.remove("op", r.id);
  return applied();
};

export const TRACK_MUTATIONS = {
  "track.create": trackCreate,
  "track.rename": trackRename,
  "track.set_stand": trackSetStand,
  "track.done": trackDone,
  "track.reopen": trackReopen,
  "track.keep": trackKeep,
  "track.dissolve": trackDissolve,
  "track.delete": trackDelete,
} satisfies Partial<Record<MutationName, MutationFn>>;
