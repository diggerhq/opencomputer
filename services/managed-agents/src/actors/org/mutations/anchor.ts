// The audience and anchors of the row an op or proposal names.

import { readPlace, readSession, readTrack, summaryOf, type Tx } from "../tx.js";

/** The audience and anchors of a row an op or proposal names: a session or a track. */
export function anchorOf(tx: Tx, target: string): { audience: string; sessionId: string | null; trackId: string | null; owner: string; atSeq: number | null } | null {
  if (target.startsWith("trk_")) {
    const t = readTrack(tx.sql, target);
    if (!t) return null;
    const agent = readSession(tx.sql, t.agent_session);
    return { audience: t.audience, sessionId: null, trackId: t.id, owner: t.owner, atSeq: agent ? summaryOf(agent).lastSeq : null };
  }
  const s = readSession(tx.sql, target);
  if (!s) return null;
  return { audience: s.audience, sessionId: s.id, trackId: readPlace(tx.sql, s.id)?.track_id ?? null, owner: s.owner, atSeq: summaryOf(s).lastSeq };
}
