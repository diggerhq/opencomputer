// Who may see and change what (spec 19.2, 34.3).

import { byOf, type Principal } from "../../auth/principal.js";
import type { Sql } from "../../durable/sql.js";
import { isSharedTo, readPlace, readTrack, trackOfAgent, type PlaceRec, type SessionRec, type TrackRec } from "./records.js";
import { isPerson, sharedWith } from "./audience.js";

/**
 * Whether `p` reads Work proper: tracks, their places, the Doc, results, proposals, ops (spec 34.3).
 * A member always; a key only with `work:read`. Reading sessions is not Work: it needs only
 * `sessions:read`, which the route checks.
 */
export const readsWork = (p: Principal): boolean => p.kind !== "key" || p.scopes.includes("work:read");

/**
 * Whether `p` reads rows of this audience. A key reads as its member does (spec 34.3: "a key is as
 * today"): the sessions of its member's audiences; Work kinds and tracks it reads only by `readsWork`,
 * checked where they are read. An agent has no audience: it reads by `seesSession`.
 */
export function visible(p: Principal, audience: string): boolean {
  if (p.kind === "platform") return true;
  if (p.kind === "agent") return false;
  return p.audiences.includes(audience) || audience === `member:${p.subject}`;
}

/** The audiences `p` reads the feed and occurrences for: those `visible` admits. */
export function audiencesOf(p: Principal): string[] {
  if (p.kind === "agent" || p.kind === "platform") return [];
  const own = `member:${p.subject}`;
  return p.audiences.includes(own) ? p.audiences : [...p.audiences, own];
}

export const isMember = (p: Principal): boolean => p.kind === "member" || p.kind === "key";
export const ownsSession = (p: Principal, s: Pick<SessionRec, "owner">): boolean => isMember(p) && s.owner === p.subject;
export const ownsTrack = (p: Principal, t: Pick<TrackRec, "owner">): boolean => isMember(p) && t.owner === p.subject;
/** The agent holds the track role for this track. */
export const holdsTrack = (p: Principal, t: Pick<TrackRec, "agent_session"> | null): boolean => p.kind === "agent" && t !== null && t.agent_session === p.session;
export const isOwnSession = (p: Principal, sessionId: string): boolean => p.kind === "agent" && p.session === sessionId;

/**
 * 19.2's agent clause for `thread.rename` and `thread.place`: it holds the track role for the
 * thread's track, and the thread was placed there by a person or started by that agent.
 */
export function agentArranges(sql: Sql, p: Principal, place: PlaceRec | null): boolean {
  if (p.kind !== "agent" || !place || place.track_id === null) return false;
  if (!holdsTrack(p, readTrack(sql, place.track_id))) return false;
  return isPerson(place.placed_by) || place.parent_session === p.session;
}

/**
 * Whether `p` may see a session at all; a mutation answers `not_found` when not (spec 39). The one
 * rule for reading a session: `getSession`, `patchSession`, the mutations, Org's work reads; the
 * member filter of `listSessions` is its SQL, and SessionLog's `mayRead` its copy over `Access`. A
 * member, or a member's key (`sessions:read` is the route's), by audience or as a person it is shared with; an agent its own session, one it started, its track's threads, its
 * track's agent, and any session shared into its own (`share`: named in a turn by someone who saw it).
 */
export function seesSession(sql: Sql, p: Principal, s: SessionRec): boolean {
  if (p.kind !== "agent") return visible(p, s.audience) || (isMember(p) && sharedWith(s).includes(byOf(p)));
  if (p.session === s.id) return true;
  if (p.session && isSharedTo(sql, s.id, p.session)) return true;
  const place = readPlace(sql, s.id);
  if (place?.parent_session === p.session) return true;
  if (place?.track_id) {
    const track = readTrack(sql, place.track_id);
    if (track && track.agent_session === p.session) return true;
  }
  if (s.role === "track" && p.session) {
    const own = readPlace(sql, p.session);
    const track = trackOfAgent(sql, s.id);
    if (own?.track_id && track && own.track_id === track.id) return true;
  }
  return false;
}

/** Whether `p` may see a track: Work proper, so a key needs `work:read` (`readsWork`). */
export function seesTrack(sql: Sql, p: Principal, t: TrackRec): boolean {
  if (p.kind !== "agent") return readsWork(p) && visible(p, t.audience);
  if (t.agent_session === p.session) return true;
  return p.session !== undefined && readPlace(sql, p.session)?.track_id === t.id;
}
